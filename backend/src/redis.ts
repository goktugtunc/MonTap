import { Redis } from "ioredis";
import { cfg } from "./config.js";

export const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
/** pub/sub için ayrı bağlantı (subscribe modundaki bağlantı komut çalıştıramaz). */
export const createSubscriber = () => new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });

export const CH = {
  tick: (feed: number) => `tick:${feed}`,
  events: "chain:events", // indexer → api WS + keeper
  txs: "txs", // relayer/keeper tx bildirimleri ("Monad hızı" paneli)
  user: (addr: string) => `user:${addr.toLowerCase()}`,
} as const;

export const KEY = {
  ticks: (feed: number) => `ticks:${feed}`, // son N imzalı tick (JSON)
  faucet: (addr: string) => `faucet:${addr.toLowerCase()}`,
  archive: (feed: number) => `archive:${feed}`, // kalibrasyon için "tsMs,price" (yalnız fiyat değişimleri)
} as const;

export const TICK_HISTORY = 2400; // 250 ms × 2400 = 10 dk
export const ARCHIVE_LEN = 57_600; // ~4 saat (değişim başına bir kayıt → pratikte daha uzun)
