import pg from "pg";
import { cfg } from "./config.js";

export const db = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10 });

export async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS bets (
      id            BIGINT PRIMARY KEY,
      user_addr     TEXT NOT NULL,
      feed          SMALLINT NOT NULL,
      band          BIGINT NOT NULL,
      window_start  BIGINT NOT NULL,
      window_end    BIGINT NOT NULL,
      stake         NUMERIC NOT NULL,
      mult_bps      INTEGER NOT NULL,
      nonce         NUMERIC NOT NULL,
      status        SMALLINT NOT NULL DEFAULT 0,  -- 0 açık, 1 kazandı, 2 kaybetti
      payout        NUMERIC,
      placed_block  BIGINT NOT NULL,
      placed_tx     TEXT NOT NULL,
      settled_tx    TEXT,
      settle_price  BIGINT,
      settle_ts_ms  BIGINT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS bets_user ON bets (user_addr, id DESC);
    CREATE INDEX IF NOT EXISTS bets_open ON bets (status, window_end) WHERE status = 0;

    CREATE TABLE IF NOT EXISTS transfers (
      tx        TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      user_addr TEXT NOT NULL,
      kind      TEXT NOT NULL,   -- deposit | withdraw
      amount    NUMERIC NOT NULL,
      block     BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tx, log_index)
    );

    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}
