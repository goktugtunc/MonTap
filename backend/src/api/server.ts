import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { z } from "zod";
import { getAddress, type Address } from "viem";
import { cfg, FEEDS } from "../config.js";
import { market, publicClient, type MarketParams } from "../chain.js";
import { MockUSDCAbi } from "../abi/MockUSDC.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { redis, createSubscriber, CH } from "../redis.js";
import { recentTicks, type Oracle } from "../oracle/oracle.js";
import type { TapRelayer } from "../relayer/taps.js";
import { ActionError, type Actions } from "../relayer/actions.js";
import { BudgetExceeded, type Sender } from "../relayer/sender.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => getAddress(a) as Address);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((h) => h as `0x${string}`);
const uint = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const int = z.union([z.string().regex(/^-?\d+$/), z.number().int()]).transform(String);

const TapBody = z.object({
  tap: z.object({
    user: address,
    feedIdx: z.number().int().min(0).max(255),
    bandIdx: int,
    windowIdx: uint,
    stake: uint,
    minMultBps: z.number().int().min(0),
    nonce: uint,
    deadline: z.number().int().positive(),
  }),
  sig: hex,
});
const SessionBody = z.object({ user: address, sessionKey: address, spendLimit: uint, expiry: z.number().int().positive(), sig: hex });
const DepositBody = z.object({ user: address, amount: uint, deadline: z.number().int().positive(), v: z.number().int(), r: hex, s: hex });
const WithdrawBody = z.object({ user: address, to: address, amount: uint, deadline: z.number().int().positive(), sig: hex });
const FaucetBody = z.object({ user: address });

/** Sponsorlu (gas'ı bizim ödediğimiz) uç noktalar için IP başına sıkı sınır. */
const sponsoredLimit = { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } };

type Deps = { params: () => MarketParams; oracle: Oracle; taps: TapRelayer; actions: Actions; relayer: Sender };

export async function buildApi({ params, oracle, taps, actions, relayer }: Deps) {
  const app = Fastify({ loggerInstance: log, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(",") });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute", redis });
  await app.register(websocket);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "geçersiz istek", issues: err.issues });
    if (err instanceof ActionError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof BudgetExceeded) return reply.code(503).send({ error: err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: "çok fazla istek" });
    log.error({ err: err.message }, "api hatası");
    return reply.code(500).send({ error: "sunucu hatası" });
  });

  // ------------------------------------------------------------------ okuma

  app.get("/health", async () => ({
    ok: true,
    oracle: oracle.address,
    sources: oracle.sources.status(),
    ticks: FEEDS.map((f) => {
      const t = oracle.latest.get(f.idx);
      return { feed: f.symbol, ageMs: t ? Date.now() - t.timestampMs : null, sources: t?.sources ?? 0 };
    }),
    relayers: relayer.addresses,
    relayerSpentThisHourMon: Number(await relayer.spentThisHour()) / 1e18,
  }));

  app.get("/config", async () => {
    const p = params();
    return {
      chainId: cfg.MONAD_CHAIN_ID,
      rpcUrl: cfg.MONAD_RPC_URL,
      explorer: cfg.MONAD_CHAIN_ID === 143 ? "https://monadvision.com" : "https://testnet.monadvision.com",
      contracts: { market: cfg.TAP_MARKET_ADDRESS, vault: cfg.HOUSE_VAULT_ADDRESS, usdc: cfg.USDC_ADDRESS },
      oracle: oracle.address,
      windowLen: p.windowLen,
      minLead: p.minLead,
      grace: p.grace,
      maxRefAge: p.maxRefAge,
      minStake: p.minStake.toString(),
      maxStake: p.maxStake.toString(),
      faucetAmount: cfg.FAUCET_AMOUNT.toString(),
      feeds: p.feeds.map((f) => ({
        idx: f.idx,
        symbol: FEEDS.find((x) => x.idx === f.idx)?.symbol,
        bandSize: f.bandSize.toString(),
        expo: f.expo,
        enabled: f.enabled,
        multipliers: f.multipliers,
      })),
    };
  });

  app.get<{ Params: { feed: string }; Querystring: { limit?: string } }>("/ticks/:feed", async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 600), 2400);
    return recentTicks(Number(req.params.feed), limit);
  });

  app.get<{ Params: { addr: string } }>("/me/:addr", async (req) => {
    const user = address.parse(req.params.addr);
    // tek multicall: istemci public RPC'ye hiç gitmesin (istek sınırı / geçici hatalar)
    const chainReads = publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...market, functionName: "balances", args: [user] },
        { address: cfg.USDC_ADDRESS, abi: MockUSDCAbi, functionName: "balanceOf", args: [user] },
        { ...market, functionName: "sessions", args: [user] },
        { address: cfg.USDC_ADDRESS, abi: MockUSDCAbi, functionName: "nonces", args: [user] },
        { ...market, functionName: "sessionNonce", args: [user] },
        { ...market, functionName: "withdrawNonce", args: [user] },
      ] as never,
    }) as Promise<unknown[]>;
    const [[balance, wallet, session, permitNonce, sessionNonce, withdrawNonce], bets, pnl] = (await Promise.all([
      chainReads,
      db.query("SELECT * FROM bets WHERE user_addr = $1 ORDER BY id DESC LIMIT 50", [user.toLowerCase()]),
      db.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(stake),0) AS staked, COALESCE(SUM(payout),0) AS paid,
                COUNT(*) FILTER (WHERE status = 1)::int AS wins
         FROM bets WHERE user_addr = $1`,
        [user.toLowerCase()],
      ),
    ])) as [[bigint, bigint, readonly [Address, bigint, bigint, bigint], bigint, bigint, bigint], any, any];
    return {
      user,
      balance: balance.toString(),
      wallet: wallet.toString(),
      nonces: { permit: permitNonce.toString(), session: sessionNonce.toString(), withdraw: withdrawNonce.toString() },
      session: { key: session[0], expiry: Number(session[1]), spendLimit: session[2].toString(), spent: session[3].toString() },
      stats: pnl.rows[0],
      bets: bets.rows.map(betRow),
    };
  });

  app.get("/bets/recent", async () => {
    const r = await db.query("SELECT * FROM bets ORDER BY id DESC LIMIT 50");
    return r.rows.map(betRow);
  });

  app.get("/leaderboard", async () => {
    const r = await db.query(
      `SELECT user_addr, COUNT(*)::int AS bets, COUNT(*) FILTER (WHERE status = 1)::int AS wins,
              (COALESCE(SUM(payout) FILTER (WHERE status <> 0), 0) - COALESCE(SUM(stake) FILTER (WHERE status <> 0), 0)) AS pnl
       FROM bets WHERE created_at > now() - interval '24 hours'
       GROUP BY user_addr ORDER BY pnl DESC LIMIT 20`,
    );
    return r.rows;
  });

  app.get("/stats", async () => {
    const r = await db.query(
      `SELECT COUNT(*)::int AS bets, COALESCE(SUM(stake),0) AS volume, COUNT(DISTINCT user_addr)::int AS players,
              COUNT(*) FILTER (WHERE status = 1)::int AS wins
       FROM bets`,
    );
    return { ...r.rows[0], txLatency: latency.summary() };
  });

  // ------------------------------------------------------------------ yazma (relayer)

  app.post("/tap", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = TapBody.parse(req.body);
    const k = `taprate:${body.tap.user.toLowerCase()}:${Math.floor(Date.now() / 60_000)}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 120);
    if (n > cfg.TAPS_PER_MIN) return reply.code(429).send({ error: "dakikalık tap sınırı" });
    return taps.submit(body.tap, body.sig);
  });

  app.post("/session", sponsoredLimit, async (req) => actions.registerSession(SessionBody.parse(req.body)));
  app.post("/deposit", sponsoredLimit, async (req) => actions.depositWithPermit(DepositBody.parse(req.body)));
  app.post("/withdraw", sponsoredLimit, async (req) => actions.withdrawBySig(WithdrawBody.parse(req.body)));
  app.post("/faucet", { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } }, async (req) =>
    actions.faucet(FaucetBody.parse(req.body).user),
  );

  // ------------------------------------------------------------------ websocket

  const clients = new Map<WebSocket, Set<string>>();
  const sub = createSubscriber();
  await sub.psubscribe("tick:*", "user:*");
  await sub.subscribe(CH.txs, CH.events);
  const fanout = (ch: string, msg: string) => {
    if (ch === CH.txs) latency.push(msg);
    const frame = `{"ch":${JSON.stringify(ch)},"data":${msg}}`;
    for (const [ws, chans] of clients) if (chans.has(ch) && ws.readyState === ws.OPEN) ws.send(frame);
  };
  sub.on("pmessage", (_p, ch, msg) => fanout(ch, msg));
  sub.on("message", (ch, msg) => fanout(ch, msg));

  app.get("/ws", { websocket: true }, (socket) => {
    const chans = new Set<string>();
    clients.set(socket, chans);
    socket.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as { op: "sub" | "unsub"; ch: string[] };
        for (const c of m.ch ?? []) {
          if (!/^(tick:\d+|user:0x[0-9a-fA-F]{40}|txs|chain:events)$/.test(c)) continue;
          const norm = c.startsWith("user:") ? c.toLowerCase() : c;
          m.op === "unsub" ? chans.delete(norm) : chans.add(norm);
        }
      } catch {
        /* yoksay */
      }
    });
    socket.on("close", () => clients.delete(socket));
  });

  return app;
}

function betRow(r: any) {
  return {
    id: String(r.id),
    user: r.user_addr,
    feed: r.feed,
    band: String(r.band),
    windowStart: Number(r.window_start),
    windowEnd: Number(r.window_end),
    stake: String(r.stake),
    multBps: r.mult_bps,
    status: ["open", "won", "lost"][r.status],
    payout: r.payout === null ? null : String(r.payout),
    placedTx: r.placed_tx,
    settledTx: r.settled_tx,
    settlePrice: r.settle_price === null ? null : String(r.settle_price),
    createdAt: r.created_at,
  };
}

/** Son 200 tx'in makbuz gecikmesi ("Monad hızı" paneli). */
const latency = {
  xs: [] as number[],
  push(msg: string) {
    try {
      const v = JSON.parse(msg).latencyMs;
      if (typeof v === "number") {
        this.xs.push(v);
        if (this.xs.length > 200) this.xs.shift();
      }
    } catch {}
  },
  summary() {
    if (!this.xs.length) return null;
    const s = [...this.xs].sort((a, b) => a - b);
    return { n: s.length, p50: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
  },
};

export type { FastifyReply };
