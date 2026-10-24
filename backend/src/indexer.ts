import { decodeEventLog, type Log } from "viem";
import { cfg } from "./config.js";
import { market, publicClient } from "./chain.js";
import { TapMarketAbi } from "./abi/TapMarket.js";
import { db } from "./db.js";
import { log } from "./log.js";
import { redis, CH } from "./redis.js";

/** Public RPC'de eth_getLogs 100 blokla sınırlı (~30 sn). */
const MAX_RANGE = 99n;
const CURSOR = `indexer:block:${cfg.TAP_MARKET_ADDRESS.toLowerCase()}`;

export type ChainEvent =
  | { type: "BetPlaced"; betId: string; user: string; feedIdx: number; bandIdx: string; windowStart: number; windowEnd: number; stake: string; multBps: number; tx: string }
  | { type: "BetWon"; betId: string; user: string; payout: string; price: string; tsMs: number; tx: string }
  | { type: "BetLost"; betId: string; user: string; tx: string }
  | { type: "Deposited" | "Withdrawn"; user: string; amount: string; tx: string };

/**
 * TapMarket event'lerini Postgres'e yazar ve Redis'e yayınlar. Tek doğruluk kaynağı zincir: relayer dışından
 * (doğrudan oyun, üçüncü taraf settle) gelen işlemler de yakalanır. İşlemler idempotent (ON CONFLICT).
 */
export class Indexer {
  private cursor = 0n;

  async start() {
    const r = await db.query("SELECT value FROM kv WHERE key = $1", [CURSOR]);
    this.cursor = r.rows[0] ? BigInt(r.rows[0].value) : cfg.START_BLOCK - 1n;
    log.info({ from: this.cursor.toString() }, "indexer başlıyor");
    void this.loop();
  }

  private async loop() {
    for (;;) {
      try {
        const head = await publicClient.getBlockNumber({ cacheTime: 0 });
        if (head > this.cursor) {
          const to = head - this.cursor > MAX_RANGE ? this.cursor + MAX_RANGE : head;
          const logs = await publicClient.getLogs({ address: market.address, fromBlock: this.cursor + 1n, toBlock: to });
          for (const l of logs) await this.handle(l);
          this.cursor = to;
          await db.query("INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [CURSOR, to.toString()]);
          if (to < head) continue; // geride: beklemeden devam
        }
      } catch (e: any) {
        log.warn({ err: e?.shortMessage ?? e?.message }, "indexer hatası");
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  private async handle(l: Log) {
    let ev;
    try {
      ev = decodeEventLog({ abi: TapMarketAbi, data: l.data, topics: l.topics });
    } catch {
      return;
    }
    const a = ev.args as any;
    const tx = l.transactionHash!;
    let out: ChainEvent | undefined;
    switch (ev.eventName) {
      case "BetPlaced":
        await db.query(
          `INSERT INTO bets (id, user_addr, feed, band, window_start, window_end, stake, mult_bps, nonce, placed_block, placed_tx)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [a.betId.toString(), a.user.toLowerCase(), a.feedIdx, a.bandIdx.toString(), a.windowStart, a.windowEnd, a.stake.toString(), a.multBps, a.nonce.toString(), l.blockNumber!.toString(), tx],
        );
        out = { type: "BetPlaced", betId: a.betId.toString(), user: a.user.toLowerCase(), feedIdx: a.feedIdx, bandIdx: a.bandIdx.toString(), windowStart: a.windowStart, windowEnd: a.windowEnd, stake: a.stake.toString(), multBps: a.multBps, tx };
        break;
      case "BetWon":
        await db.query(
          `UPDATE bets SET status = 1, payout = $2, settle_price = $3, settle_ts_ms = $4, settled_tx = $5, settled_at = now() WHERE id = $1`,
          [a.betId.toString(), a.payout.toString(), a.price.toString(), a.publishTime.toString(), tx],
        );
        out = { type: "BetWon", betId: a.betId.toString(), user: a.user.toLowerCase(), payout: a.payout.toString(), price: a.price.toString(), tsMs: Number(a.publishTime), tx };
        break;
      case "BetLost":
        await db.query(`UPDATE bets SET status = 2, payout = 0, settled_tx = $2, settled_at = now() WHERE id = $1`, [a.betId.toString(), tx]);
        out = { type: "BetLost", betId: a.betId.toString(), user: a.user.toLowerCase(), tx };
        break;
      case "Deposited":
      case "Withdrawn":
        await db.query(
          `INSERT INTO transfers (tx, log_index, user_addr, kind, amount, block) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [tx, l.logIndex, a.user.toLowerCase(), ev.eventName === "Deposited" ? "deposit" : "withdraw", a.amount.toString(), l.blockNumber!.toString()],
        );
        out = { type: ev.eventName, user: a.user.toLowerCase(), amount: a.amount.toString(), tx };
        break;
    }
    if (out) {
      const json = JSON.stringify(out);
      await redis.pipeline().publish(CH.events, json).publish(CH.user(out.user), json).exec();
    }
  }
}
