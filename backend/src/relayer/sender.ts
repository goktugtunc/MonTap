import {
  encodeFunctionData,
  formatTransactionReceipt,
  keccak256,
  parseGwei,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { publicClient, monad } from "../chain.js";
import { log } from "../log.js";
import { redis, CH } from "../redis.js";

export type TxRequest = {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /**
   * Monad gas LİMİTİ üzerinden ücret alır. Sık çağrılar (placeBets/settle) ölçülmüş sabit limit verir;
   * verilmezse eth_estimateGas × 1.1 kullanılır (seyrek işlemler için en ucuzu).
   */
  gas?: bigint;
  /** Tahmin başarısız olursa kullanılacak limit. */
  gasFallback?: bigint;
  label: string;
};

export type TxResult = { hash: Hex; receipt: TransactionReceipt; latencyMs: number; from: Address };

export class BudgetExceeded extends Error {
  constructor() {
    super("relayer saatlik gas bütçesi doldu");
  }
}

const spendKey = (name: string) => `gasspend:${name}:${Math.floor(Date.now() / 3_600_000)}`;

const PRIORITY = parseGwei("2");

/**
 * Tek anahtar için sıralı gönderici. Monad'da public mempool yok ve RPC nonce boşluklu tx'leri sessizce kabul
 * edebilir → nonce yerelde tutulur, hata olursa zincirden yeniden senkronlanır. Her anahtarda aynı anda tek tx
 * uçuşta (reserve balance bütçesi ve sıralama sorunlarını önler).
 */
class Lane {
  readonly account: PrivateKeyAccount;
  onSpent?: (wei: bigint) => void;
  private nonce?: number;
  private busy = false;
  private queue: { req: TxRequest; resolve: (r: TxResult) => void; reject: (e: Error) => void }[] = [];

  constructor(pk: Hex) {
    this.account = privateKeyToAccount(pk);
  }

  get pending() {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  send(req: TxRequest): Promise<TxResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      void this.drain();
    });
  }

  private async drain() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      job.resolve(await this.sendOne(job.req));
    } catch (e) {
      this.nonce = undefined; // yeniden senkronla
      job.reject(e as Error);
    } finally {
      this.busy = false;
      void this.drain();
    }
  }

  private async sendOne(req: TxRequest): Promise<TxResult> {
    if (this.nonce === undefined) {
      this.nonce = await publicClient.getTransactionCount({ address: this.account.address, blockTag: "pending" });
    }
    const block = await baseFee();
    const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });
    let gas = req.gas;
    if (gas === undefined) {
      try {
        gas = ((await publicClient.estimateGas({ account: this.account.address, to: req.to, data })) * 110n) / 100n;
      } catch (e) {
        if (req.gasFallback === undefined) throw e;
        gas = req.gasFallback;
      }
    }
    const serialized = await this.account.signTransaction({
      chainId: monad.id,
      type: "eip1559",
      to: req.to,
      data,
      gas,
      nonce: this.nonce,
      maxPriorityFeePerGas: PRIORITY,
      maxFeePerGas: block * 2n + PRIORITY, // ödenen = base + priority; tavan sadece güvenlik payı
    });
    const t0 = Date.now();
    const receipt = await sendSync(serialized);
    const latencyMs = Date.now() - t0;
    this.nonce++;
    this.onSpent?.(receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n));
    const result = { hash: receipt.transactionHash, receipt, latencyMs, from: this.account.address };
    void redis.publish(
      CH.txs,
      JSON.stringify({
        label: req.label,
        hash: receipt.transactionHash,
        block: receipt.blockNumber.toString(),
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        latencyMs,
        at: Date.now(),
      }),
    );
    if (receipt.status !== "success") log.warn({ label: req.label, hash: receipt.transactionHash }, "tx revert etti");
    return result;
  }
}

let cachedBase: { v: bigint; at: number } | undefined;
async function baseFee(): Promise<bigint> {
  if (cachedBase && Date.now() - cachedBase.at < 5_000) return cachedBase.v;
  const b = await publicClient.getBlock({ blockTag: "latest" });
  cachedBase = { v: b.baseFeePerGas ?? parseGwei("100"), at: Date.now() };
  return cachedBase.v;
}

/** `eth_sendRawTransactionSync`: makbuz blok önerildiği anda döner (~300 ms). Desteklenmezse klasik yola düşer. */
let syncSupported = true;
async function sendSync(raw: Hex): Promise<TransactionReceipt> {
  if (syncSupported) {
    try {
      const r = await publicClient.request({ method: "eth_sendRawTransactionSync" as never, params: [raw, 5_000] as never });
      return formatTransactionReceipt(r as never) as TransactionReceipt;
    } catch (e: any) {
      const msg = String(e?.details ?? e?.message ?? e);
      if (/method not found|not supported|does not exist/i.test(msg)) {
        syncSupported = false;
        log.warn("eth_sendRawTransactionSync desteklenmiyor → klasik gönderim");
      } else if (!/timeout|timed out/i.test(msg)) {
        throw e;
      }
      // zaman aşımı: tx gönderildi, makbuzu bekle
      const hash = keccak256(raw);
      return publicClient.waitForTransactionReceipt({ hash, pollingInterval: 200, timeout: 20_000 });
    }
  }
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: raw });
  return publicClient.waitForTransactionReceipt({ hash, pollingInterval: 200, timeout: 20_000 });
}

/** Birden fazla anahtar: en boş hatta gönder. */
export class Sender {
  private lanes: Lane[];
  /**
   * @param name bütçe anahtarı (relayer / keeper)
   * @param hourlyBudgetWei bu saatte harcanan (gasUsed × fiyat) bunu aşarsa yeni tx reddedilir. 0 = sınırsız.
   */
  constructor(
    keys: Hex[],
    private name: string,
    private hourlyBudgetWei = 0n,
  ) {
    this.lanes = keys.map((k) => new Lane(k));
    for (const l of this.lanes) l.onSpent = (wei) => void redis.pipeline().incrby(spendKey(name), wei.toString()).expire(spendKey(name), 7200).exec();
  }

  async spentThisHour(): Promise<bigint> {
    return BigInt((await redis.get(spendKey(this.name))) ?? "0");
  }
  get size() {
    return this.lanes.length;
  }
  get addresses() {
    return this.lanes.map((l) => l.account.address);
  }
  get idle() {
    return this.lanes.some((l) => l.pending === 0);
  }
  async send(req: TxRequest): Promise<TxResult> {
    if (!this.lanes.length) throw new Error("gönderici anahtarı yok");
    if (this.hourlyBudgetWei > 0n && (await this.spentThisHour()) >= this.hourlyBudgetWei) throw new BudgetExceeded();
    const lane = this.lanes.reduce((a, b) => (b.pending < a.pending ? b : a));
    return lane.send(req);
  }
}
