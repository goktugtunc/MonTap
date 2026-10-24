import { decodeEventLog, getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { cfg } from "../config.js";
import { domain, market, publicClient, types, type MarketParams } from "../chain.js";
import { TapMarketAbi } from "../abi/TapMarket.js";
import { log } from "../log.js";
import { redis, CH } from "../redis.js";
import type { Oracle } from "../oracle/oracle.js";
import { BudgetExceeded, type Sender } from "./sender.js";

export type TapInput = {
  user: Address;
  feedIdx: number;
  bandIdx: string;
  windowIdx: string;
  stake: string;
  minMultBps: number;
  nonce: string;
  deadline: number;
};

export type TapResult =
  | { status: "placed"; betId: string; multBps: number; tx: Hex; latencyMs: number; block: string }
  | { status: "rejected"; reason: string; tx?: Hex };

/** Kontrattaki `Reject` enum'unun sırası. */
const REJECT = ["None", "Feed", "Deadline", "Session", "SpendLimit", "BadSig", "Nonce", "Stake", "Balance", "Window", "Mult", "Payout", "CellCap", "WindowCap", "Capacity"];

/**
 * Yedek limit (tahmin başarısızsa). forge (network=monad) ölçümü: n=1 385k, 6 824k, 20 1.98M, 100 7.5M.
 * Normalde eth_estimateGas × 1.1 kullanılır: Monad limit üzerinden ücret aldığı için en ucuzu.
 */
const gasFallback = (n: number) => ((320_000n + 85_000n * BigInt(n)) * 11n) / 10n;
/** Batch başına ~300k sabit maliyet var → tap'ler biriktirilir: bu kadar tap ya da en eskisi bu kadar beklediyse gönder. */
const FLUSH_SIZE = 20;
const MAX_WAIT_MS = 500;
/** Pencere başı en az minLead + bu kadar sn sonra olmalı (bekleme + gönderim + blok payı). */
const INCLUSION_MARGIN_SEC = 1.5;

type Pending = { tap: TapInput; sig: Hex; at: number; resolve: (r: TapResult) => void };
type Session = { key: Address; expiry: number; spendLimit: bigint; spent: bigint; at: number };

export class TapRelayer {
  private queues = new Map<number, Pending[]>();
  private sessions = new Map<string, Session>();
  private inflight = new Set<string>(); // user:nonce

  constructor(
    private params: MarketParams,
    private oracle: Oracle,
    private sender: Sender,
  ) {}

  start() {
    setInterval(() => void this.flushAll(), 100);
  }

  setParams(p: MarketParams) {
    this.params = p;
  }

  /** Session önbelleğini güncelle (registerSession sonrası). */
  invalidateSession(user: Address) {
    this.sessions.delete(user.toLowerCase());
  }

  async submit(tap: TapInput, sig: Hex): Promise<TapResult> {
    const err = await this.precheck(tap, sig);
    if (err) return { status: "rejected", reason: err };
    const id = `${tap.user.toLowerCase()}:${tap.nonce}`;
    if (this.inflight.has(id)) return { status: "rejected", reason: "Nonce" };
    this.inflight.add(id);
    return new Promise<TapResult>((resolve) => {
      const q = this.queues.get(tap.feedIdx) ?? [];
      q.push({ tap, sig, at: Date.now(), resolve: (r) => (this.inflight.delete(id), resolve(r)) });
      this.queues.set(tap.feedIdx, q);
    });
  }

  /** Zincire gitmeden önce ucuz kontroller: geçersiz tap'ler için gas harcanmaz. */
  private async precheck(tap: TapInput, sig: Hex): Promise<string | undefined> {
    const feed = this.params.feeds.find((f) => f.idx === tap.feedIdx);
    if (!feed?.enabled) return "Feed";
    const now = Date.now() / 1000;
    if (tap.deadline < now + 1) return "Deadline";
    const start = Number(tap.windowIdx) * this.params.windowLen;
    if (start < now + this.params.minLead + INCLUSION_MARGIN_SEC) return "Window";
    if (Number(tap.windowIdx) - Math.floor(now / this.params.windowLen) >= 12) return "Window";
    const stake = BigInt(tap.stake);
    if (stake < this.params.minStake || stake > this.params.maxStake) return "Stake";

    const s = await this.session(tap.user);
    if (!s || s.expiry < now) return "Session";
    if (s.spent + stake > s.spendLimit) return "SpendLimit";
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({ domain, types: { Tap: types.Tap }, primaryType: "Tap", message: toMessage(tap), signature: sig });
    } catch {
      return "BadSig";
    }
    if (signer.toLowerCase() !== s.key.toLowerCase()) return "BadSig";
    return undefined;
  }

  private async session(user: Address): Promise<Session | undefined> {
    const k = user.toLowerCase();
    const c = this.sessions.get(k);
    if (c && Date.now() - c.at < 30_000) return c;
    const [key, expiry, spendLimit, spent] = (await publicClient.readContract({
      ...market,
      functionName: "sessions",
      args: [user],
    })) as readonly [Address, bigint, bigint, bigint];
    if (key === "0x0000000000000000000000000000000000000000") return undefined;
    const s = { key, expiry: Number(expiry), spendLimit, spent, at: Date.now() };
    this.sessions.set(k, s);
    return s;
  }

  private async flushAll() {
    for (const feedIdx of this.queues.keys()) {
      if (!this.sender.idle) return; // tüm hatlar meşgul: tap'ler birikir, bir sonraki turda daha büyük batch
      await this.flush(feedIdx);
    }
  }

  private async flush(feedIdx: number) {
    const q = this.queues.get(feedIdx);
    if (!q?.length) return;
    if (q.length < FLUSH_SIZE && Date.now() - q[0].at < MAX_WAIT_MS) return;
    const tick = this.oracle.latest.get(feedIdx);
    if (!tick || Date.now() - tick.timestampMs > 1_500) return; // taze referans fiyat yok → bekle
    const batch = q.splice(0, cfg.MAX_TAPS_PER_TX);

    const ref = { feedIdx, price: BigInt(tick.price), timestampMs: BigInt(tick.timestampMs) };
    const taps = batch.map((p) => toMessage(p.tap));
    this.sender
      .send({
        to: market.address,
        abi: TapMarketAbi,
        functionName: "placeBets",
        args: [ref, tick.sig, taps, batch.map((p) => p.sig)],
        gasFallback: gasFallback(batch.length),
        label: `placeBets×${batch.length}`,
      })
      .then(({ hash, receipt, latencyMs }) => {
        const placed = new Map<string, { betId: string; multBps: number }>();
        const rejected = new Map<string, string>();
        for (const l of receipt.logs) {
          if (getAddress(l.address) !== getAddress(market.address)) continue;
          try {
            const ev = decodeEventLog({ abi: TapMarketAbi, data: l.data, topics: l.topics });
            if (ev.eventName === "BetPlaced") {
              const a = ev.args as any;
              placed.set(`${a.user.toLowerCase()}:${a.nonce}`, { betId: a.betId.toString(), multBps: Number(a.multBps) });
            } else if (ev.eventName === "TapRejected") {
              const a = ev.args as any;
              rejected.set(`${a.user.toLowerCase()}:${a.nonce}`, REJECT[Number(a.reason)] ?? String(a.reason));
            }
          } catch {
            /* başka event */
          }
        }
        for (const p of batch) {
          const id = `${p.tap.user.toLowerCase()}:${p.tap.nonce}`;
          const ok = placed.get(id);
          let r: TapResult;
          if (receipt.status === "success" && ok) {
            const s = this.sessions.get(p.tap.user.toLowerCase());
            if (s) s.spent += BigInt(p.tap.stake);
            r = { status: "placed", betId: ok.betId, multBps: ok.multBps, tx: hash, latencyMs, block: receipt.blockNumber.toString() };
          } else {
            r = { status: "rejected", reason: rejected.get(id) ?? (receipt.status === "success" ? "Unknown" : "Reverted"), tx: hash };
          }
          p.resolve(r);
          void redis.publish(CH.user(p.tap.user), JSON.stringify({ type: "tap", nonce: p.tap.nonce, ...r }));
        }
      })
      .catch((e) => {
        log.error({ err: e.message, n: batch.length }, "placeBets gönderilemedi");
        const reason = e instanceof BudgetExceeded ? "RelayerBudget" : "RelayerError";
        for (const p of batch) p.resolve({ status: "rejected", reason });
      });
  }
}

export function toMessage(t: TapInput) {
  return {
    user: getAddress(t.user),
    feedIdx: t.feedIdx,
    bandIdx: BigInt(t.bandIdx),
    windowIdx: BigInt(t.windowIdx),
    stake: BigInt(t.stake),
    minMultBps: t.minMultBps,
    nonce: BigInt(t.nonce),
    deadline: BigInt(t.deadline),
  };
}
