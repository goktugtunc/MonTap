import { z } from "zod";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a as `0x${string}`);
const pk = hex.length(66).transform((k) => k as `0x${string}`);

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),

  MONAD_CHAIN_ID: z.coerce.number(),
  MONAD_RPC_URL: z.string().url(),
  TAP_MARKET_ADDRESS: addr,
  HOUSE_VAULT_ADDRESS: addr,
  USDC_ADDRESS: addr,
  START_BLOCK: z.coerce.bigint(),

  ORACLE_PRIVATE_KEY: pk.optional(),
  RELAYER_PRIVATE_KEYS: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((k) => pk.parse(k.trim())) : [])),
  KEEPER_PRIVATE_KEY: pk.optional(),

  TICK_INTERVAL_MS: z.coerce.number().default(250),
  MAX_TAPS_PER_TX: z.coerce.number().default(120),
  FAUCET_AMOUNT: z.coerce.bigint().default(100_000_000n), // 100 tUSDC
  FAUCET_COOLDOWN_SEC: z.coerce.number().default(600),
  /** Relayer'ın saatte en fazla harcayacağı MON (spam'e karşı). Keeper bundan muaf. */
  RELAYER_HOURLY_BUDGET_MON: z.coerce.number().default(3),
  /** Kullanıcı başına dakikalık tap sınırı. */
  TAPS_PER_MIN: z.coerce.number().default(60),
});

export const cfg = schema.parse(process.env);
export type Hex = `0x${string}`;

/** Feed tanımları: zincirdeki feedIdx ile eşleşir. Kaynaklar `oracle/sources.ts` içinde. */
export const FEEDS = [
  { idx: 0, symbol: "BTC" },
  { idx: 1, symbol: "MON" },
] as const;
export type FeedSymbol = (typeof FEEDS)[number]["symbol"];
