/**
 * Canlı API üzerinden uçtan uca senaryo (frontend'in yapacağının aynısı):
 * yeni cüzdan → faucet → permit ile yatırma → session → 6 tap → keeper settle/expire → sonuçlar.
 * Kullanım: API=https://monback.isinigetir.com npx tsx scripts/e2e.ts
 */
import { createPublicClient, http, parseSignature, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const API = process.env.API ?? "http://localhost:4000";
const j = async (path: string, body?: unknown) => {
  const r = await fetch(API + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await r.json();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(data)}`);
  return data as any;
};
const t0 = Date.now();
const step = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

const cfg = await j("/config");
const client = createPublicClient({ transport: http(cfg.rpcUrl) });
const user = privateKeyToAccount(generatePrivateKey());
const session = privateKeyToAccount(generatePrivateKey());
const domain = { name: "MonTap", version: "1", chainId: cfg.chainId, verifyingContract: cfg.contracts.market as Address };
step(`kullanıcı ${user.address}`);

const f = await j("/faucet", { user: user.address });
step(`faucet: ${f.amount} tUSDC, ${f.latencyMs} ms, tx ${f.tx}`);

const amount = 50_000_000n;
const deadline = Math.floor(Date.now() / 1000) + 600;
const nonces = (await client.readContract({
  address: cfg.contracts.usdc,
  abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "nonces",
  args: [user.address],
})) as bigint;
const permitSig = await user.signTypedData({
  domain: { name: "MonTap Test USDC", version: "1", chainId: cfg.chainId, verifyingContract: cfg.contracts.usdc },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit",
  message: { owner: user.address, spender: cfg.contracts.market, value: amount, nonce: nonces, deadline: BigInt(deadline) },
});
const { r, s, v } = parseSignature(permitSig);
const d = await j("/deposit", { user: user.address, amount: amount.toString(), deadline, v: Number(v), r, s });
step(`deposit 50 tUSDC: ${d.latencyMs} ms`);

const expiry = Math.floor(Date.now() / 1000) + 3600;
const spendLimit = 1_000_000_000n;
const grant = await user.signTypedData({
  domain,
  types: { SessionGrant: [{ name: "user", type: "address" }, { name: "sessionKey", type: "address" }, { name: "spendLimit", type: "uint96" }, { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" }] },
  primaryType: "SessionGrant",
  message: { user: user.address, sessionKey: session.address, spendLimit, expiry: BigInt(expiry), nonce: 0n },
});
const sess = await j("/session", { user: user.address, sessionKey: session.address, spendLimit: spendLimit.toString(), expiry, sig: grant });
step(`session: ${sess.latencyMs} ms`);

const [tick] = await j("/ticks/0?limit=1");
const bandSize = BigInt(cfg.feeds[0].bandSize);
const center = BigInt(tick.price) / bandSize;
const nowSec = Date.now() / 1000;
const curWin = Math.floor(nowSec / cfg.windowLen);
const TapT = [
  { name: "user", type: "address" }, { name: "feedIdx", type: "uint8" }, { name: "bandIdx", type: "int64" }, { name: "windowIdx", type: "uint64" },
  { name: "stake", type: "uint96" }, { name: "minMultBps", type: "uint32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
] as const;
const cells: [bigint, number][] = [];
for (const col of [2, 3]) for (const db of [-1n, 0n, 1n]) cells.push([center + db, curWin + col]);
step(`BTC $${Number(tick.price) / 1e8}, merkez band ${center}; ${cells.length} tap gönderiliyor`);

const sentAt = Date.now();
const results = await Promise.all(
  cells.map(async ([band, win], i) => {
    const tap = { user: user.address, feedIdx: 0, bandIdx: band.toString(), windowIdx: String(win), stake: "1000000", minMultBps: 0, nonce: String(i + 1), deadline: Math.floor(Date.now() / 1000) + 30 };
    const sig = await session.signTypedData({
      domain, types: { Tap: TapT }, primaryType: "Tap",
      message: { ...tap, bandIdx: band, windowIdx: BigInt(win), stake: 1_000_000n, nonce: BigInt(i + 1), deadline: BigInt(tap.deadline) },
    });
    const res = await j("/tap", { tap, sig });
    return { band: band - center, col: win - curWin, ...res, roundTripMs: Date.now() - sentAt };
  }),
);
for (const r of results) console.log(`   band ${r.band >= 0 ? "+" : ""}${r.band} kolon ${r.col}: ${r.status} ${r.status === "placed" ? `bet #${r.betId} ${(r.multBps / 1e4).toFixed(2)}x, zincir ${r.latencyMs} ms, uçtan uca ${r.roundTripMs} ms` : r.reason}`);

const lastEnd = (curWin + 4) * cfg.windowLen + cfg.grace + 6;
step(`son pencere + grace bekleniyor (~${Math.round(lastEnd - Date.now() / 1000)} sn)`);
await new Promise((r) => setTimeout(r, (lastEnd - Date.now() / 1000) * 1000));
for (let i = 0; i < 10; i++) {
  const me = await j(`/me/${user.address}`);
  const open = me.bets.filter((b: any) => b.status === "open").length;
  if (!open || i === 9) {
    for (const b of me.bets.reverse()) console.log(`   bet #${b.id} band ${BigInt(b.band) - center} ${b.status}${b.status === "won" ? ` +${Number(b.payout) / 1e6} tUSDC` : ""}`);
    step(`bakiye ${Number(me.balance) / 1e6} tUSDC (başlangıç 50)`);
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
const stats = await j("/stats");
console.log("tx gecikmesi:", stats.txLatency);
