import type { Config, FeedCfg } from "./api";

/** Kontrattaki grid ile birebir: band = floor(price / bandSize), pencere = floor(sn / windowLen). */
export const bandOf = (price: bigint, bandSize: bigint) => price / bandSize;
export const windowOf = (sec: number, windowLen: number) => Math.floor(sec / windowLen);

/** Relayer'ın ön kontrolüyle aynı pay: pencere başı ≥ now + minLead + 1.5 sn. */
export const INCLUSION_MARGIN = 1.5;

export function multiplier(feed: FeedCfg, dist: number, col: number): number {
  if (dist < 0 || dist > 15 || col < 0 || col > 11) return 0;
  return feed.multipliers[dist]?.[col] ?? 0;
}

export function tappable(cfg: Config, windowIdx: number, nowSec: number) {
  return windowIdx * cfg.windowLen >= nowSec + cfg.minLead + INCLUSION_MARGIN;
}

export const fmtUsd = (price: bigint | number, expo = 8) => {
  const v = typeof price === "bigint" ? Number(price) / 10 ** expo : price;
  return v >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : v.toFixed(5);
};
export const fmtUsdc = (x: string | bigint | number) => (Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
