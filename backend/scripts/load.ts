/**
 * Küçük yük testi: U kullanıcı aynı anda T'şer tap gönderir → kaç tx'e paketlendi, gecikmeler.
 * Kullanım: API=https://monback.isinigetir.com USERS=2 TAPS=10 npx tsx scripts/load.ts
 */
import { parseSignature, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const API = process.env.API ?? "http://localhost:4000";
const USERS = Number(process.env.USERS ?? 2);
const TAPS = Number(process.env.TAPS ?? 10);
const j = async (path: string, body?: unknown) => {
  const r = await fetch(API + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(d)}`);
  return d as any;
};
const TapT = [
  { name: "user", type: "address" }, { name: "feedIdx", type: "uint8" }, { name: "bandIdx", type: "int64" }, { name: "windowIdx", type: "uint64" },
  { name: "stake", type: "uint96" }, { name: "minMultBps", type: "uint32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
] as const;

const cfg = await j("/config");
const domain = { name: "MonTap", version: "1", chainId: cfg.chainId, verifyingContract: cfg.contracts.market as Address };

// hazırlık: her kullanıcı için faucet + permit + session (sıralı, relayer'ı yormadan)
const players = [];
for (let u = 0; u < USERS; u++) {
  const user = privateKeyToAccount(generatePrivateKey());
  const session = privateKeyToAccount(generatePrivateKey());
  await j("/faucet", { user: user.address });
  const me = await j(`/me/${user.address}`);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const permit = await user.signTypedData({
    domain: { name: "MonTap Test USDC", version: "1", chainId: cfg.chainId, verifyingContract: cfg.contracts.usdc },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit",
    message: { owner: user.address, spender: cfg.contracts.market, value: BigInt(me.wallet), nonce: BigInt(me.nonces.permit), deadline: BigInt(deadline) },
  });
  const { r, s, v } = parseSignature(permit);
  await j("/deposit", { user: user.address, amount: me.wallet, deadline, v: Number(v), r, s });
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const grant = await user.signTypedData({
    domain,
    types: { SessionGrant: [{ name: "user", type: "address" }, { name: "sessionKey", type: "address" }, { name: "spendLimit", type: "uint96" }, { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" }] },
    primaryType: "SessionGrant",
    message: { user: user.address, sessionKey: session.address, spendLimit: 1_000_000_000n, expiry: BigInt(expiry), nonce: 0n },
  });
  await j("/session", { user: user.address, sessionKey: session.address, spendLimit: "1000000000", expiry, sig: grant });
  players.push({ user, session });
}
console.log(`${USERS} oyuncu hazır; ${USERS * TAPS} tap aynı anda gönderiliyor…`);

const [tick] = await j("/ticks/0?limit=1");
const center = BigInt(tick.price) / BigInt(cfg.feeds[0].bandSize);
const win0 = Math.floor(Date.now() / 1000 / cfg.windowLen) + 2;
const jobs = [];
for (const p of players) {
  for (let i = 0; i < TAPS; i++) {
    const band = center + BigInt((i % 7) - 3);
    const win = win0 + Math.floor(i / 7);
    const nonce = BigInt(Date.now()) * 1000n + BigInt(i);
    const deadline = Math.floor(Date.now() / 1000) + 30;
    jobs.push(
      (async () => {
        const sig = await p.session.signTypedData({ domain, types: { Tap: TapT }, primaryType: "Tap", message: { user: p.user.address, feedIdx: 0, bandIdx: band, windowIdx: BigInt(win), stake: 1_000_000n, minMultBps: 0, nonce, deadline: BigInt(deadline) } });
        const t0 = Date.now();
        const r = await j("/tap", { tap: { user: p.user.address, feedIdx: 0, bandIdx: band.toString(), windowIdx: String(win), stake: "1000000", minMultBps: 0, nonce: nonce.toString(), deadline }, sig });
        return { ...r, e2e: Date.now() - t0 };
      })(),
    );
  }
}
const res = await Promise.all(jobs);
const placed = res.filter((r) => r.status === "placed");
const txs = new Map<string, number>();
for (const r of placed) txs.set(r.tx, (txs.get(r.tx) ?? 0) + 1);
const e2e = res.map((r) => r.e2e).sort((a, b) => a - b);
console.log(`yerleşen ${placed.length}/${res.length}; ${txs.size} tx'e paketlendi: ${[...txs.values()].join(", ")} tap/tx`);
console.log(`zincir gecikmesi: ${[...new Set(placed.map((r) => r.latencyMs))].join(", ")} ms; uçtan uca p50 ${e2e[e2e.length >> 1]} ms, max ${e2e[e2e.length - 1]} ms`);
const rej = res.filter((r) => r.status !== "placed").map((r) => r.reason);
if (rej.length) console.log("red:", rej);
