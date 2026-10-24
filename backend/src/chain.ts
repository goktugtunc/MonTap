import { createPublicClient, defineChain, http, type Address } from "viem";
import { cfg } from "./config.js";
import { TapMarketAbi } from "./abi/TapMarket.js";

export const monad = defineChain({
  id: cfg.MONAD_CHAIN_ID,
  name: cfg.MONAD_CHAIN_ID === 143 ? "Monad" : "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [cfg.MONAD_RPC_URL] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const publicClient = createPublicClient({ chain: monad, transport: http(cfg.MONAD_RPC_URL, { retryCount: 3 }) });

export const market = { address: cfg.TAP_MARKET_ADDRESS, abi: TapMarketAbi } as const;

/** TapMarket EIP-712 domain'i — kontrattaki EIP712("MonTap", "1") ile aynı. */
export const domain = {
  name: "MonTap",
  version: "1",
  chainId: cfg.MONAD_CHAIN_ID,
  verifyingContract: cfg.TAP_MARKET_ADDRESS as Address,
} as const;

export const types = {
  PriceTick: [
    { name: "feedIdx", type: "uint8" },
    { name: "price", type: "int64" },
    { name: "timestampMs", type: "uint64" },
  ],
  Tap: [
    { name: "user", type: "address" },
    { name: "feedIdx", type: "uint8" },
    { name: "bandIdx", type: "int64" },
    { name: "windowIdx", type: "uint64" },
    { name: "stake", type: "uint96" },
    { name: "minMultBps", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  SessionGrant: [
    { name: "user", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "spendLimit", type: "uint96" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export type MarketParams = {
  windowLen: number;
  minLead: number;
  grace: number;
  maxRefAge: number;
  minStake: bigint;
  maxStake: bigint;
  feeds: { idx: number; bandSize: bigint; expo: number; enabled: boolean; multipliers: number[][] }[];
};

/** Zincirdeki parametreleri tek multicall ile okur (public RPC'nin istek/sn sınırına takılmamak için). */
export async function loadMarketParams(feedIdxs: number[]): Promise<MarketParams> {
  const c = (functionName: string, args: unknown[] = []) => ({ ...market, functionName, args }) as never;
  const scalars = ["windowLen", "minLead", "grace", "maxRefAge", "minStake", "maxStake"];
  const res = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      ...scalars.map((n) => c(n)),
      ...feedIdxs.flatMap((i) => [c("feeds", [i]), c("getMultipliers", [i])]),
    ],
  });
  const [windowLen, minLead, grace, maxRefAge, minStake, maxStake] = res.slice(0, 6) as unknown as [number, number, number, number, bigint, bigint];
  const feeds = feedIdxs.map((idx, k) => {
    const [, bandSize, expo, , enabled] = res[6 + 2 * k] as unknown as readonly [Address, bigint, number, number, boolean];
    const mult = res[7 + 2 * k] as unknown as readonly (readonly number[])[];
    return { idx, bandSize, expo, enabled, multipliers: mult.map((r) => [...r]) };
  });
  return { windowLen: Number(windowLen), minLead: Number(minLead), grace: Number(grace), maxRefAge: Number(maxRefAge), minStake, maxStake, feeds };
}
