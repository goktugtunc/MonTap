import { createWalletClient, custom, defineChain, getAddress, parseSignature, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { api, type Config, type Me } from "./api";

type TypedData = { domain: any; types: any; primaryType: string; message: any };

/** Kullanıcının ana cüzdanı: tek seferlik izinleri (session, permit, çekim) imzalar. Gas ödemez. */
export type MainWallet = { kind: "burner" | "injected"; address: Address; sign: (d: TypedData) => Promise<Hex> };

const LS = {
  burner: "montap.burner",
  session: (u: string) => `montap.session.${u.toLowerCase()}`,
  kind: "montap.kind",
};

const safeLS = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

export const chainOf = (cfg: Config) =>
  defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 143 ? "Monad" : "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: { default: { name: "MonadVision", url: cfg.explorer } },
  });

export const domainOf = (cfg: Config) => ({ name: "MonTap", version: "1", chainId: cfg.chainId, verifyingContract: cfg.contracts.market });

export const TYPES = {
  Tap: [
    { name: "user", type: "address" },
    { name: "feedIdx", type: "uint8" },
    { name: "bandIdx", type: "int64" },
    { name: "windowIdx", type: "uint64" },
    { name: "stake", type: "uint96" },
    { name: "minMultBps", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  SessionGrant: [
    { name: "user", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "spendLimit", type: "uint96" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
  Withdraw: [
    { name: "user", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// ------------------------------------------------------------------ ana cüzdan

export function burnerWallet(): MainWallet {
  let pk = safeLS.get(LS.burner) as Hex | null;
  if (!pk) {
    pk = generatePrivateKey();
    safeLS.set(LS.burner, pk);
  }
  const acc = privateKeyToAccount(pk);
  safeLS.set(LS.kind, "burner");
  return { kind: "burner", address: acc.address, sign: (d) => acc.signTypedData(d as any) };
}

export function hasInjected() {
  return typeof window !== "undefined" && !!(window as any).ethereum;
}

export async function injectedWallet(cfg: Config): Promise<MainWallet> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("Tarayıcı cüzdanı bulunamadı");
  const chain = chainOf(cfg);
  const wc = createWalletClient({ chain, transport: custom(eth) });
  const [address] = await wc.requestAddresses();
  // MetaMask, EIP-712 domain chainId'si aktif ağla eşleşmezse imzalamaz → Monad'a geç
  try {
    await wc.switchChain({ id: chain.id });
  } catch {
    await wc.addChain({ chain });
  }
  safeLS.set(LS.kind, "injected");
  return { kind: "injected", address: getAddress(address), sign: (d) => wc.signTypedData({ account: address, ...(d as any) }) };
}

export const rememberedKind = () => safeLS.get(LS.kind) as "burner" | "injected" | null;
export const forget = () => safeLS.del(LS.kind);

// ------------------------------------------------------------------ session

/** Oturum anahtarı tarayıcıda kalır; her dokunuşu o imzalar (popup yok). Harcama limiti ve süresi zincirde. */
export async function ensureSession(cfg: Config, main: MainWallet, me: Me): Promise<PrivateKeyAccount> {
  const now = Math.floor(Date.now() / 1000);
  const stored = safeLS.get(LS.session(main.address));
  if (stored) {
    const { pk } = JSON.parse(stored) as { pk: Hex };
    const acc = privateKeyToAccount(pk);
    const remaining = BigInt(me.session.spendLimit) - BigInt(me.session.spent);
    if (me.session.key.toLowerCase() === acc.address.toLowerCase() && me.session.expiry > now + 300 && remaining > 50_000_000n) return acc;
  }
  const pk = generatePrivateKey();
  const acc = privateKeyToAccount(pk);
  const expiry = now + 24 * 3600;
  const spendLimit = 10_000_000_000n; // 10k tUSDC
  const nonce = BigInt(me.nonces.session);
  const sig = await main.sign({
    domain: domainOf(cfg),
    types: { SessionGrant: TYPES.SessionGrant },
    primaryType: "SessionGrant",
    message: { user: main.address, sessionKey: acc.address, spendLimit, expiry: BigInt(expiry), nonce },
  });
  await api.session({ user: main.address, sessionKey: acc.address, spendLimit: spendLimit.toString(), expiry, sig });
  safeLS.set(LS.session(main.address), JSON.stringify({ pk, expiry }));
  return acc;
}

// ------------------------------------------------------------------ bakiye

/** Cüzdandaki tUSDC'yi permit ile oyun bakiyesine aktarır (gassız). */
export async function depositAll(cfg: Config, main: MainWallet, me: Me): Promise<bigint> {
  const amount = BigInt(me.wallet);
  const nonce = BigInt(me.nonces.permit);
  if (amount === 0n) return 0n;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const sig = await main.sign({
    domain: { name: "MonTap Test USDC", version: "1", chainId: cfg.chainId, verifyingContract: cfg.contracts.usdc },
    types: { Permit: TYPES.Permit },
    primaryType: "Permit",
    message: { owner: main.address, spender: cfg.contracts.market, value: amount, nonce, deadline: BigInt(deadline) },
  });
  const { r, s, v } = parseSignature(sig);
  await api.deposit({ user: main.address, amount: amount.toString(), deadline, v: Number(v), r, s });
  return amount;
}

/** Oyun bakiyesini ana cüzdana çeker (gassız, ana cüzdan imzalar). */
export async function withdrawAll(cfg: Config, main: MainWallet, me: Me, amount: bigint) {
  const nonce = BigInt(me.nonces.withdraw);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const sig = await main.sign({
    domain: domainOf(cfg),
    types: { Withdraw: TYPES.Withdraw },
    primaryType: "Withdraw",
    message: { user: main.address, to: main.address, amount, nonce, deadline: BigInt(deadline) },
  });
  return api.withdraw({ user: main.address, to: main.address, amount: amount.toString(), deadline, sig });
}

// ------------------------------------------------------------------ tap

let nonceSeq = 0;
/** Bitmap nonce: sıralı olması gerekmez, sadece tekil. ms zaman damgası × 1000 + sayaç. */
export const nextNonce = () => BigInt(Date.now()) * 1000n + BigInt(nonceSeq++ % 1000);

export async function signTap(
  cfg: Config,
  session: PrivateKeyAccount,
  t: { user: Address; feedIdx: number; bandIdx: bigint; windowIdx: number; stake: bigint; minMultBps: number },
) {
  const nonce = nextNonce();
  const deadline = Math.floor(Date.now() / 1000) + 20;
  const message = { ...t, windowIdx: BigInt(t.windowIdx), nonce, deadline: BigInt(deadline) };
  const sig = await session.signTypedData({ domain: domainOf(cfg), types: { Tap: TYPES.Tap }, primaryType: "Tap", message });
  return {
    tap: {
      user: t.user,
      feedIdx: t.feedIdx,
      bandIdx: t.bandIdx.toString(),
      windowIdx: String(t.windowIdx),
      stake: t.stake.toString(),
      minMultBps: t.minMultBps,
      nonce: nonce.toString(),
      deadline,
    },
    sig,
  };
}
