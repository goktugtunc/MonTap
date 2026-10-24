import WebSocket from "ws";
import { log } from "../log.js";

/** Normalize sembol: "BTC" | "MON" | "USDT" (USDT/USD kuru). */
export type Asset = "BTC" | "MON" | "USDT";
export type Quote = { venue: string; asset: Asset; inUsdt: boolean; mid: number; at: number };

type VenueSpec = {
  name: string;
  url: string;
  /** borsa sembolü → bizim varlığımız */
  symbols: Record<string, { asset: Asset; inUsdt: boolean }>;
  subscribe: (ws: WebSocket, symbols: string[]) => void;
  /** mesajdan (sembol, bid, ask) çıkar; ilgisizse null */
  parse: (msg: any) => { sym: string; bid?: number; ask?: number }[] | null;
  ping?: (ws: WebSocket) => void;
};

const n = (x: unknown) => (x === undefined || x === null || x === "" ? undefined : Number(x));

const VENUES: VenueSpec[] = [
  {
    name: "binance",
    url: "wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker",
    symbols: { BTCUSDT: { asset: "BTC", inUsdt: true } },
    subscribe: () => {},
    parse: (m) => (m?.data?.s ? [{ sym: m.data.s, bid: n(m.data.b), ask: n(m.data.a) }] : null),
  },
  {
    name: "coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    symbols: {
      "BTC-USD": { asset: "BTC", inUsdt: false },
      "MON-USD": { asset: "MON", inUsdt: false },
      "USDT-USD": { asset: "USDT", inUsdt: false },
    },
    subscribe: (ws, s) => ws.send(JSON.stringify({ type: "subscribe", product_ids: s, channels: ["ticker", "heartbeat"] })),
    parse: (m) => (m?.type === "ticker" ? [{ sym: m.product_id, bid: n(m.best_bid), ask: n(m.best_ask) }] : null),
  },
  {
    name: "okx",
    url: "wss://ws.okx.com:8443/ws/v5/public",
    symbols: { "BTC-USDT": { asset: "BTC", inUsdt: true }, "MON-USDT": { asset: "MON", inUsdt: true } },
    subscribe: (ws, s) =>
      ws.send(JSON.stringify({ op: "subscribe", args: s.map((instId) => ({ channel: "bbo-tbt", instId })) })),
    parse: (m) =>
      m?.arg?.channel === "bbo-tbt" && m.data?.[0]
        ? [{ sym: m.arg.instId, bid: n(m.data[0].bids?.[0]?.[0]), ask: n(m.data[0].asks?.[0]?.[0]) }]
        : null,
    ping: (ws) => ws.send("ping"),
  },
  {
    name: "bybit",
    url: "wss://stream.bybit.com/v5/public/spot",
    symbols: { BTCUSDT: { asset: "BTC", inUsdt: true }, MONUSDT: { asset: "MON", inUsdt: true } },
    subscribe: (ws, s) => ws.send(JSON.stringify({ op: "subscribe", args: s.map((x) => `orderbook.1.${x}`) })),
    parse: (m) =>
      typeof m?.topic === "string" && m.topic.startsWith("orderbook.1.") && m.data
        ? [{ sym: m.data.s, bid: n(m.data.b?.[0]?.[0]), ask: n(m.data.a?.[0]?.[0]) }]
        : null,
    ping: (ws) => ws.send(JSON.stringify({ op: "ping" })),
  },
  {
    name: "kraken",
    url: "wss://ws.kraken.com/v2",
    symbols: {
      "BTC/USD": { asset: "BTC", inUsdt: false },
      "MON/USD": { asset: "MON", inUsdt: false },
      "USDT/USD": { asset: "USDT", inUsdt: false },
    },
    subscribe: (ws, s) => ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: s } })),
    parse: (m) =>
      m?.channel === "ticker" && Array.isArray(m.data)
        ? m.data.map((d: any) => ({ sym: d.symbol, bid: n(d.bid), ask: n(d.ask) }))
        : null,
  },
];

/** Bağlantı canlılığı: bu süre içinde hiç mesaj gelmezse kaynak ölü sayılır ve yeniden bağlanılır. */
const LIVENESS_MS = 15_000;
/** Canlı bağlantıda bile bu süreden eski kotasyon kullanılmaz. */
const MAX_QUOTE_AGE_MS = 60_000;

export class PriceSources {
  private quotes = new Map<string, Quote>(); // `${venue}:${asset}`
  private books = new Map<string, { bid?: number; ask?: number }>();
  private lastMsg = new Map<string, number>();

  start() {
    for (const v of VENUES) this.connect(v, 0);
  }

  /** Canlı ve taze kotasyonlar. */
  live(asset: Asset, now = Date.now()): Quote[] {
    const out: Quote[] = [];
    for (const q of this.quotes.values()) {
      if (q.asset !== asset) continue;
      if (now - (this.lastMsg.get(q.venue) ?? 0) > LIVENESS_MS) continue;
      if (now - q.at > MAX_QUOTE_AGE_MS) continue;
      out.push(q);
    }
    return out;
  }

  status(now = Date.now()) {
    return VENUES.map((v) => ({
      venue: v.name,
      alive: now - (this.lastMsg.get(v.name) ?? 0) <= LIVENESS_MS,
      lastMsgAgoMs: now - (this.lastMsg.get(v.name) ?? 0),
    }));
  }

  private connect(v: VenueSpec, attempt: number) {
    const ws = new WebSocket(v.url, { handshakeTimeout: 10_000 });
    let pingTimer: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;

    ws.on("open", () => {
      attempt = 0;
      this.lastMsg.set(v.name, Date.now());
      v.subscribe(ws, Object.keys(v.symbols));
      if (v.ping) pingTimer = setInterval(() => v.ping!(ws), 15_000);
      else pingTimer = setInterval(() => ws.ping(), 15_000);
      watchdog = setInterval(() => {
        if (Date.now() - (this.lastMsg.get(v.name) ?? 0) > LIVENESS_MS) {
          log.warn({ venue: v.name }, "oracle kaynağı sessiz, yeniden bağlanıyor");
          ws.terminate();
        }
      }, 5_000);
      log.info({ venue: v.name }, "oracle kaynağı bağlandı");
    });

    ws.on("message", (raw) => {
      this.lastMsg.set(v.name, Date.now());
      const text = raw.toString();
      if (text === "pong") return;
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const updates = v.parse(msg);
      if (!updates) return;
      for (const u of updates) {
        const meta = v.symbols[u.sym];
        if (!meta) continue;
        const key = `${v.name}:${meta.asset}`;
        const book = this.books.get(key) ?? {};
        if (u.bid !== undefined && u.bid > 0) book.bid = u.bid;
        if (u.ask !== undefined && u.ask > 0) book.ask = u.ask;
        this.books.set(key, book);
        if (book.bid && book.ask && book.ask >= book.bid) {
          this.quotes.set(key, { venue: v.name, asset: meta.asset, inUsdt: meta.inUsdt, mid: (book.bid + book.ask) / 2, at: Date.now() });
        }
      }
    });

    const cleanup = () => {
      clearInterval(pingTimer);
      clearInterval(watchdog);
    };
    ws.on("close", () => {
      cleanup();
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      log.warn({ venue: v.name, delay }, "oracle kaynağı kapandı");
      setTimeout(() => this.connect(v, attempt + 1), delay);
    });
    ws.on("error", (err) => log.warn({ venue: v.name, err: err.message }, "oracle kaynağı hatası"));
  }
}
