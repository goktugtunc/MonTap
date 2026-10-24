import { decodeEventLog, getAddress } from "viem";
import { FEEDS } from "../config.js";
import { market, type MarketParams } from "../chain.js";
import { TapMarketAbi } from "../abi/TapMarket.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { createSubscriber, CH } from "../redis.js";
import { recentTicks, type SignedTick } from "../oracle/oracle.js";
import type { ChainEvent } from "../indexer.js";
import type { Sender } from "../relayer/sender.js";

type OpenBet = { id: string; feed: number; band: bigint; ws: number; we: number; busy: boolean };

const MAX_WINS_PER_TX = 60;
const MAX_EXPIRE_PER_TX = 120;
const LOOP_MS = 1_000;

/**
 * Kazanma kanıtı + kayıp kapatma. settle/expire izinsiz olduğu için keeper güvenilir taraf değil, sadece hizmet:
 * herkes aynı imzalı tick'lerle aynı işlemi yapabilir.
 */
export class Keeper {
  private open = new Map<number, Map<string, OpenBet>>(); // feed → id → bet
  private pending = new Map<string, SignedTick>(); // betId → kanıt tick
  private bandSize = new Map<number, bigint>();
  private sending = false;

  constructor(
    private params: MarketParams,
    private sender: Sender,
  ) {
    for (const f of params.feeds) this.bandSize.set(f.idx, f.bandSize);
    for (const f of FEEDS) this.open.set(f.idx, new Map());
  }

  async start() {
    const r = await db.query("SELECT id, feed, band, window_start, window_end FROM bets WHERE status = 0");
    for (const row of r.rows) this.add({ id: String(row.id), feed: row.feed, band: BigInt(row.band), ws: Number(row.window_start), we: Number(row.window_end), busy: false });
    log.info({ open: r.rowCount }, "keeper başladı");

    const sub = createSubscriber();
    await sub.subscribe(CH.events, ...FEEDS.map((f) => CH.tick(f.idx)));
    sub.on("message", (ch, msg) => {
      if (ch === CH.events) this.onEvent(JSON.parse(msg) as ChainEvent);
      else this.onTick(JSON.parse(msg) as SignedTick);
    });
    setInterval(() => void this.loop(), LOOP_MS);
  }

  private add(b: OpenBet) {
    this.open.get(b.feed)?.set(b.id, b);
  }

  private remove(id: string) {
    for (const m of this.open.values()) m.delete(id);
    this.pending.delete(id);
  }

  private onEvent(e: ChainEvent) {
    if (e.type === "BetPlaced") {
      this.add({ id: e.betId, feed: e.feedIdx, band: BigInt(e.bandIdx), ws: e.windowStart, we: e.windowEnd, busy: false });
    } else if (e.type === "BetWon" || e.type === "BetLost") {
      this.remove(e.betId);
    }
  }

  private matches(b: OpenBet, t: SignedTick) {
    const size = this.bandSize.get(b.feed);
    if (!size) return false;
    return BigInt(t.price) / size === b.band && t.timestampMs >= b.ws * 1000 && t.timestampMs < b.we * 1000;
  }

  private onTick(t: SignedTick) {
    const bets = this.open.get(t.feedIdx);
    if (!bets) return;
    for (const b of bets.values()) {
      if (!b.busy && !this.pending.has(b.id) && this.matches(b, t)) this.pending.set(b.id, t);
    }
  }

  /**
   * Saniyede bir tek `resolve` tx'i: biriken tüm kazançlar (tick başına grup) + süresi dolan kayıplar.
   * Batch başına sabit maliyet yüksek olduğu için (soğuk sayfalar, kasa transferi) hepsi aynı işlemde.
   */
  private async loop() {
    if (this.sending) return;
    const wins = this.collectWins();
    const expired = await this.collectExpired();
    if (!wins.length && !expired.length) return;

    const ids = [...wins.flatMap((w) => w.ids), ...expired];
    ids.forEach((id) => this.setBusy(id, true));
    this.sending = true;
    try {
      const { receipt } = await this.sender.send({
        to: market.address,
        abi: TapMarketAbi,
        functionName: "resolve",
        args: [
          wins.map(({ tick, ids }) => ({
            tick: { feedIdx: tick.feedIdx, price: BigInt(tick.price), timestampMs: BigInt(tick.timestampMs) },
            sig: tick.sig,
            betIds: ids.map(BigInt),
          })),
          expired.map(BigInt),
        ],
        label: `resolve ${wins.reduce((a, w) => a + w.ids.length, 0)}W/${expired.length}L`,
      });
      const done = new Set<string>();
      for (const l of receipt.logs) {
        if (getAddress(l.address) !== getAddress(market.address)) continue;
        try {
          const ev = decodeEventLog({ abi: TapMarketAbi, data: l.data, topics: l.topics });
          if (ev.eventName === "BetWon" || ev.eventName === "BetLost") done.add((ev.args as any).betId.toString());
        } catch {}
      }
      for (const id of ids) done.has(id) ? this.remove(id) : this.setBusy(id, false);
    } catch (e: any) {
      log.warn({ err: e.message, n: ids.length }, "resolve başarısız, tekrar denenecek");
      ids.forEach((id) => this.setBusy(id, false));
      // kanıtları geri koy
      for (const w of wins) for (const id of w.ids) this.pending.set(id, w.tick);
    } finally {
      this.sending = false;
    }
  }

  private collectWins() {
    const groups = new Map<string, { tick: SignedTick; ids: string[] }>();
    let n = 0;
    for (const [id, t] of this.pending) {
      if (n >= MAX_WINS_PER_TX) break;
      const g = groups.get(t.sig) ?? { tick: t, ids: [] };
      g.ids.push(id);
      groups.set(t.sig, g);
      this.pending.delete(id);
      ++n;
    }
    return [...groups.values()];
  }

  /** Grace dolan bahisler: önce tick geçmişinde gözden kaçmış bir değme var mı bak (varsa kazanç), yoksa kayıp. */
  private async collectExpired(): Promise<string[]> {
    const now = Date.now() / 1000;
    const out: string[] = [];
    for (const [feed, bets] of this.open) {
      const due = [...bets.values()].filter((b) => !b.busy && !this.pending.has(b.id) && now >= b.we + this.params.grace + 1);
      if (!due.length) continue;
      const history = await recentTicks(feed);
      for (const b of due) {
        const proof = history.find((t) => this.matches(b, t));
        if (proof) this.pending.set(b.id, proof);
        else if (out.length < MAX_EXPIRE_PER_TX) out.push(b.id);
      }
    }
    return out;
  }

  private setBusy(id: string, busy: boolean) {
    for (const m of this.open.values()) {
      const b = m.get(id);
      if (b) b.busy = busy;
    }
  }
}
