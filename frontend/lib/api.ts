export const API = process.env.NEXT_PUBLIC_API_URL ?? "https://monback.isinigetir.com";

export type FeedCfg = { idx: number; symbol: string; bandSize: string; expo: number; enabled: boolean; multipliers: number[][] };
export type Config = {
  chainId: number;
  rpcUrl: string;
  explorer: string;
  contracts: { market: `0x${string}`; vault: `0x${string}`; usdc: `0x${string}` };
  oracle: `0x${string}`;
  windowLen: number;
  minLead: number;
  grace: number;
  minStake: string;
  maxStake: string;
  faucetAmount: string;
  feeds: FeedCfg[];
};
export type Tick = { feedIdx: number; price: string; timestampMs: number; sig: `0x${string}`; sources: number };
export type BetRow = {
  id: string;
  user: string;
  feed: number;
  band: string;
  windowStart: number;
  windowEnd: number;
  stake: string;
  multBps: number;
  status: "open" | "won" | "lost";
  payout: string | null;
  placedTx: string;
  settledTx: string | null;
};
export type Me = {
  user: string;
  balance: string;
  wallet: string;
  nonces: { permit: string; session: string; withdraw: string };
  session: { key: string; expiry: number; spendLimit: string; spent: string };
  stats: { n: number; staked: string; paid: string; wins: number };
  bets: BetRow[];
};
export type TapResult =
  | { status: "placed"; betId: string; multBps: number; tx: string; latencyMs: number; block: string }
  | { status: "rejected"; reason: string; tx?: string };

export class ApiError extends Error {}

async function req<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((data as any)?.error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  config: () => req<Config>("/config"),
  ticks: (feed: number, limit = 400) => req<Tick[]>(`/ticks/${feed}?limit=${limit}`),
  me: (addr: string) => req<Me>(`/me/${addr}`),
  recent: () => req<BetRow[]>("/bets/recent"),
  leaderboard: () => req<{ user_addr: string; bets: number; wins: number; pnl: string }[]>("/leaderboard"),
  stats: () => req<{ bets: number; volume: string; players: number; wins: number; txLatency: { p50: number; p90: number; avg: number; n: number } | null }>("/stats"),
  faucet: (user: string) => req<{ tx: string; latencyMs: number; amount: string }>("/faucet", { user }),
  deposit: (b: unknown) => req<{ tx: string; latencyMs: number }>("/deposit", b),
  session: (b: unknown) => req<{ tx: string; latencyMs: number }>("/session", b),
  withdraw: (b: unknown) => req<{ tx: string; latencyMs: number }>("/withdraw", b),
  tap: (b: unknown) => req<TapResult>("/tap", b),
};

/** Kendini yeniden bağlayan WS; kanal aboneliklerini bağlantı kopsa da korur. */
export class Live {
  private ws?: WebSocket;
  private chans = new Set<string>();
  private handlers = new Map<string, Set<(d: any) => void>>();
  private retry = 0;

  constructor() {
    if (typeof window !== "undefined") this.open();
  }

  private open() {
    const ws = new WebSocket(API.replace(/^http/, "ws") + "/ws");
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.chans.size) ws.send(JSON.stringify({ op: "sub", ch: [...this.chans] }));
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as { ch: string; data: unknown };
        this.handlers.get(m.ch)?.forEach((h) => h(m.data));
      } catch {}
    };
    ws.onclose = () => setTimeout(() => this.open(), Math.min(10_000, 500 * 2 ** this.retry++));
  }

  on(ch: string, h: (d: any) => void) {
    const c = ch.startsWith("user:") ? ch.toLowerCase() : ch;
    if (!this.handlers.has(c)) this.handlers.set(c, new Set());
    this.handlers.get(c)!.add(h);
    if (!this.chans.has(c)) {
      this.chans.add(c);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: "sub", ch: [c] }));
    }
    return () => this.handlers.get(c)?.delete(h);
  }
}
