import { privateKeyToAccount } from "viem/accounts";
import { cfg, FEEDS, type FeedSymbol } from "../config.js";
import { domain, types } from "../chain.js";
import { log } from "../log.js";
import { redis, CH, KEY, TICK_HISTORY, ARCHIVE_LEN } from "../redis.js";
import { PriceSources, type Quote } from "./sources.js";

export type SignedTick = {
  feedIdx: number;
  price: string; // int64, expo -8
  timestampMs: number;
  sig: `0x${string}`;
  sources: number;
};

const EXPO = 8;
/** Feed başına en az bu kadar bağımsız borsa olmadan tick üretilmez. */
const MIN_SOURCES: Record<FeedSymbol, number> = { BTC: 3, MON: 2 };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Borsa mid fiyatlarının medyanı → USD'ye normalize (USDT pariteleri canlı USDT/USD kuruyla) → EIP-712 imza.
 * Tick'ler Redis pub/sub ile yayınlanır ve son 10 dk listede tutulur (keeper kanıt, frontend grafik için).
 */
export class Oracle {
  readonly sources = new PriceSources();
  private account = cfg.ORACLE_PRIVATE_KEY ? privateKeyToAccount(cfg.ORACLE_PRIVATE_KEY) : undefined;
  latest = new Map<number, SignedTick>();

  get address() {
    return this.account?.address;
  }

  start() {
    if (!this.account) {
      log.warn("ORACLE_PRIVATE_KEY yok → oracle kapalı");
      return;
    }
    this.sources.start();
    setInterval(() => void this.emit().catch((e) => log.error({ err: e.message }, "tick hatası")), cfg.TICK_INTERVAL_MS);
  }

  private usdtUsd(now: number): number | undefined {
    const qs = this.sources.live("USDT", now);
    return qs.length ? median(qs.map((q) => q.mid)) : undefined;
  }

  /** Feed'in USD fiyatı; yeterli kaynak yoksa undefined. */
  priceUsd(symbol: FeedSymbol, now = Date.now()): { usd: number; quotes: Quote[] } | undefined {
    const usdt = this.usdtUsd(now);
    const quotes = this.sources.live(symbol, now).filter((q) => !q.inUsdt || usdt !== undefined);
    if (quotes.length < MIN_SOURCES[symbol]) return undefined;
    const usd = median(quotes.map((q) => (q.inUsdt ? q.mid * usdt! : q.mid)));
    return { usd, quotes };
  }

  private async emit() {
    const now = Date.now();
    const pipe = redis.pipeline();
    for (const f of FEEDS) {
      const p = this.priceUsd(f.symbol, now);
      if (!p) continue;
      const price = BigInt(Math.round(p.usd * 10 ** EXPO));
      const message = { feedIdx: f.idx, price, timestampMs: BigInt(now) };
      const sig = await this.account!.signTypedData({ domain, types: { PriceTick: types.PriceTick }, primaryType: "PriceTick", message });
      const tick: SignedTick = { feedIdx: f.idx, price: price.toString(), timestampMs: now, sig, sources: p.quotes.length };
      if (this.latest.get(f.idx)?.price !== tick.price) {
        pipe.lpush(KEY.archive(f.idx), `${now},${tick.price}`);
        pipe.ltrim(KEY.archive(f.idx), 0, ARCHIVE_LEN - 1);
      }
      this.latest.set(f.idx, tick);
      const json = JSON.stringify(tick);
      pipe.publish(CH.tick(f.idx), json);
      pipe.lpush(KEY.ticks(f.idx), json);
      pipe.ltrim(KEY.ticks(f.idx), 0, TICK_HISTORY - 1);
    }
    await pipe.exec();
  }
}

/** Redis'teki son tick'ler (en yeni önce). */
export async function recentTicks(feedIdx: number, limit = TICK_HISTORY): Promise<SignedTick[]> {
  const raw = await redis.lrange(KEY.ticks(feedIdx), 0, limit - 1);
  return raw.map((r) => JSON.parse(r) as SignedTick);
}
