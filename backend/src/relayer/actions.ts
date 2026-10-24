import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { cfg } from "../config.js";
import { domain, market, publicClient, types } from "../chain.js";
import { TapMarketAbi } from "../abi/TapMarket.js";
import { MockUSDCAbi } from "../abi/MockUSDC.js";
import { redis, KEY } from "../redis.js";
import type { Sender } from "./sender.js";
import type { TapRelayer } from "./taps.js";

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Kullanıcının gas ödemediği tek seferlik işlemler (session, yatırma, faucet, çekim). */
export class Actions {
  constructor(
    private sender: Sender,
    private taps: TapRelayer,
  ) {}

  async registerSession(a: { user: Address; sessionKey: Address; spendLimit: string; expiry: number; sig: Hex }) {
    if (a.expiry <= Date.now() / 1000) throw new ActionError("expiry geçmiş");
    // gas harcamadan önce imzayı doğrula
    const nonce = (await publicClient.readContract({ ...market, functionName: "sessionNonce", args: [a.user] })) as bigint;
    const signer = await recoverTypedDataAddress({
      domain,
      types: { SessionGrant: types.SessionGrant },
      primaryType: "SessionGrant",
      message: { user: a.user, sessionKey: a.sessionKey, spendLimit: BigInt(a.spendLimit), expiry: BigInt(a.expiry), nonce },
      signature: a.sig,
    });
    if (getAddress(signer) !== getAddress(a.user)) throw new ActionError("geçersiz session imzası");
    const r = await this.sender.send({
      to: market.address,
      abi: TapMarketAbi,
      functionName: "registerSession",
      args: [a.user, a.sessionKey, BigInt(a.spendLimit), BigInt(a.expiry), a.sig],
      label: "registerSession",
    });
    this.taps.invalidateSession(a.user);
    return pick(r);
  }

  async depositWithPermit(a: { user: Address; amount: string; deadline: number; v: number; r: Hex; s: Hex }) {
    const r = await this.sender.send({
      to: market.address,
      abi: TapMarketAbi,
      functionName: "depositWithPermit",
      args: [a.user, BigInt(a.amount), BigInt(a.deadline), a.v, a.r, a.s],
      label: "depositWithPermit",
    });
    return pick(r);
  }

  async withdrawBySig(a: { user: Address; to: Address; amount: string; deadline: number; sig: Hex }) {
    const r = await this.sender.send({
      to: market.address,
      abi: TapMarketAbi,
      functionName: "withdrawBySig",
      args: [a.user, a.to, BigInt(a.amount), BigInt(a.deadline), a.sig],
      label: "withdrawBySig",
    });
    return pick(r);
  }

  /** Test tUSDC basar (adres başına cooldown). */
  async faucet(user: Address) {
    const ok = await redis.set(KEY.faucet(user), "1", "EX", cfg.FAUCET_COOLDOWN_SEC, "NX");
    if (!ok) {
      const ttl = await redis.ttl(KEY.faucet(user));
      throw new ActionError(`faucet ${ttl} sn sonra tekrar kullanılabilir`, 429);
    }
    try {
      const r = await this.sender.send({
        to: cfg.USDC_ADDRESS,
        abi: MockUSDCAbi,
        functionName: "mint",
        args: [user, cfg.FAUCET_AMOUNT],
        label: "faucet",
      });
      return { ...pick(r), amount: cfg.FAUCET_AMOUNT.toString() };
    } catch (e) {
      await redis.del(KEY.faucet(user));
      throw e;
    }
  }
}

const pick = (r: { hash: Hex; latencyMs: number; receipt: { status: string; blockNumber: bigint } }) => {
  if (r.receipt.status !== "success") throw new ActionError(`işlem revert etti: ${r.hash}`, 502);
  return { tx: r.hash, latencyMs: r.latencyMs, block: r.receipt.blockNumber.toString() };
};
