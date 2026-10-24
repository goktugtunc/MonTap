"use client";
import { create } from "zustand";
import type { PrivateKeyAccount } from "viem/accounts";
import { api, Live, type BetRow, type Config, type Tick } from "./api";
import { bandOf, multiplier, tappable, windowOf } from "./grid";
import { burnerWallet, depositAll, ensureSession, injectedWallet, signTap, withdrawAll, type MainWallet } from "./wallet";
import { sfx } from "./sfx";

export type CellStatus = "pending" | "placed" | "won" | "lost" | "rejected";
export type LocalBet = {
  key: string; // feed:band:window
  feed: number;
  band: bigint;
  window: number;
  stake: bigint;
  multBps: number;
  status: CellStatus;
  confirmed: boolean; // zincirde settle edildi mi
  betId?: string;
  tx?: string;
  settledTx?: string;
  latencyMs?: number;
  reason?: string;
  at: number;
  wonAt?: number;
};
export type TxItem = { label: string; hash: string; block: string; status: string; latencyMs: number; at: number };
export type Toast = { id: number; kind: "info" | "win" | "error"; text: string };

type OnboardStep = "idle" | "wallet" | "faucet" | "deposit" | "session" | "ready" | "error";

type State = {
  cfg?: Config;
  feed: number;
  stake: bigint;
  main?: MainWallet;
  step: OnboardStep;
  stepError?: string;
  balance: bigint;
  walletUsdc: bigint;
  bets: Record<string, LocalBet>; // key → bet
  txs: TxItem[];
  toasts: Toast[];
  sessionPnl: bigint;
  muted: boolean;
  lastPrice: Record<number, number>;
};

export const useGame = create<State>(() => ({
  feed: 0,
  stake: 1_000_000n,
  step: "idle",
  balance: 0n,
  walletUsdc: 0n,
  bets: {},
  txs: [],
  toasts: [],
  sessionPnl: 0n,
  muted: false,
  lastPrice: {},
}));

// ------------------------------------------------------------------ canlı fiyat (React dışı; canvas 60 fps okur)

export type PricePoint = { t: number; p: number; raw: bigint }; // ms, fiyat (USD float), ham (expo −8)
export const series: Record<number, PricePoint[]> = { 0: [], 1: [] };
const KEEP_MS = 90_000;

let live: Live | undefined;

/**
 * Sunucu saati tahmini: pencereler mutlak zamana bağlı, istemci saati birkaç sn kaysa relayer tap'leri reddeder.
 * Canlı tick'ler ~50–150 ms gecikmeyle gelir → (tick zamanı − alış zamanı) değerlerinin üst yüzdeliği iyi bir tahmin.
 */
const skew: number[] = [];
let clockOffset = 0;
export const now = () => Date.now() + clockOffset;
function observeClock(tickMs: number) {
  skew.push(tickMs - Date.now());
  if (skew.length > 40) skew.shift();
  const s = [...skew].sort((a, b) => a - b);
  clockOffset = s[Math.floor(s.length * 0.8)] + 80;
}
let session: PrivateKeyAccount | undefined;
let toastSeq = 0;

const set = useGame.setState;
const get = useGame.getState;

export function toast(kind: Toast["kind"], text: string) {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 4500 : 2800);
}

function pushTick(t: Tick, isLive = true) {
  const arr = series[t.feedIdx] ?? (series[t.feedIdx] = []);
  const p = Number(t.price) / 1e8;
  const last = arr[arr.length - 1];
  if (last && t.timestampMs <= last.t) return;
  if (isLive) observeClock(t.timestampMs);
  arr.push({ t: t.timestampMs, p, raw: BigInt(t.price) });
  while (arr.length && arr[0].t < t.timestampMs - KEEP_MS) arr.shift();
  set((s) => ({ lastPrice: { ...s.lastPrice, [t.feedIdx]: p } }));
  detectWins(t);
}

/** Zincir settle'ını beklemeden kazancı göster: kontrattaki kuralın aynısı (pencere içi ms, bant eşleşmesi). */
function detectWins(t: Tick) {
  const cfg = get().cfg;
  if (!cfg) return;
  const feed = cfg.feeds.find((f) => f.idx === t.feedIdx);
  if (!feed) return;
  const band = bandOf(BigInt(t.price), BigInt(feed.bandSize));
  let changed: LocalBet[] = [];
  for (const b of Object.values(get().bets)) {
    if (b.feed !== t.feedIdx || b.status !== "placed") continue;
    const ws = b.window * cfg.windowLen * 1000;
    if (t.timestampMs >= ws && t.timestampMs < ws + cfg.windowLen * 1000 && band === b.band) {
      changed.push({ ...b, status: "won", wonAt: Date.now() });
    }
  }
  if (changed.length) {
    set((s) => {
      const bets = { ...s.bets };
      let pnl = s.sessionPnl;
      for (const b of changed) {
        bets[b.key] = b;
        pnl += (b.stake * BigInt(b.multBps)) / 10_000n;
      }
      return { bets, sessionPnl: pnl };
    });
    for (const b of changed) {
      sfx.win();
      toast("win", `+${(Number((b.stake * BigInt(b.multBps)) / 10_000n) / 1e6).toFixed(2)} tUSDC · ${(b.multBps / 1e4).toFixed(2)}x`);
    }
  }
}

/** Grace + pay geçmiş, değmemiş bahisleri yerelde kayıp göster (zincir BetLost'u da gelecek). */
function sweepLosses() {
  const cfg = get().cfg;
  if (!cfg) return;
  const nowSec = now() / 1000;
  const lost = Object.values(get().bets).filter((b) => b.status === "placed" && nowSec > (b.window + 1) * cfg.windowLen + 0.6);
  if (!lost.length) return;
  set((s) => {
    const bets = { ...s.bets };
    for (const b of lost) bets[b.key] = { ...b, status: "lost" };
    return { bets };
  });
}

// ------------------------------------------------------------------ başlangıç

export async function boot() {
  if (get().cfg) return;
  const cfg = await api.config();
  set({ cfg });
  live = new Live();
  for (const f of cfg.feeds) {
    const hist = await api.ticks(f.idx, 400).catch(() => []);
    for (const t of hist.reverse()) pushTick(t, false);
    live.on(`tick:${f.idx}`, (t: Tick) => pushTick(t));
  }
  live.on("txs", (tx: TxItem) => set((s) => ({ txs: [tx, ...s.txs].slice(0, 14) })));
  setInterval(sweepLosses, 500);
}

// ------------------------------------------------------------------ onboarding

export async function start(kind: "burner" | "injected") {
  const cfg = get().cfg;
  if (!cfg) return;
  try {
    set({ step: "wallet", stepError: undefined });
    const main = kind === "burner" ? burnerWallet() : await injectedWallet(cfg);
    set({ main });
    subscribeUser(main.address);

    let me = await api.me(main.address);
    if (BigInt(me.balance) < 1_000_000n) {
      if (BigInt(me.wallet) === 0n) {
        set({ step: "faucet" });
        await api.faucet(main.address).catch((e) => {
          if (!/sn sonra/.test(e.message)) throw e; // cooldown: cüzdanda zaten olabilir
        });
        me = await api.me(main.address);
      }
      set({ step: "deposit" });
      await depositAll(cfg, main, me);
      me = await api.me(main.address);
    }
    set({ step: "session" });
    session = await ensureSession(cfg, main, me);
    await refreshMe();
    set({ step: "ready" });
    sfx.ready();
  } catch (e: any) {
    set({ step: "error", stepError: e?.shortMessage ?? e?.message ?? String(e) });
  }
}

function subscribeUser(addr: string) {
  live?.on(`user:${addr}`, (ev: any) => {
    if (ev.type === "BetWon" || ev.type === "BetLost") {
      set((s) => {
        const b = Object.values(s.bets).find((x) => x.betId === ev.betId);
        if (!b) return {};
        const status: CellStatus = ev.type === "BetWon" ? "won" : b.status === "won" ? "won" : "lost";
        return { bets: { ...s.bets, [b.key]: { ...b, status, confirmed: true, settledTx: ev.tx, wonAt: b.wonAt ?? (status === "won" ? Date.now() : undefined) } } };
      });
      void refreshMe();
    } else if (ev.type === "Deposited" || ev.type === "Withdrawn") {
      void refreshMe();
    }
  });
}

export async function refreshMe() {
  const main = get().main;
  if (!main) return;
  const me = await api.me(main.address);
  set({ balance: BigInt(me.balance), walletUsdc: BigInt(me.wallet) });
  return me;
}

export async function topUp() {
  const { cfg, main } = get();
  if (!cfg || !main) return;
  try {
    await api.faucet(main.address);
    await depositAll(cfg, main, await api.me(main.address));
    await refreshMe();
    toast("info", "100 tUSDC yüklendi");
  } catch (e: any) {
    toast("error", e.message);
  }
}

export async function cashOut() {
  const { cfg, main, balance } = get();
  if (!cfg || !main || balance === 0n) return;
  try {
    await withdrawAll(cfg, main, await api.me(main.address), balance);
    await refreshMe();
    toast("info", "Bakiye cüzdana çekildi");
  } catch (e: any) {
    toast("error", e.message);
  }
}

// ------------------------------------------------------------------ tap

const REASONS: Record<string, string> = {
  Window: "Bu pencere kapandı",
  Mult: "Fiyat kaydı, çarpan değişti",
  Balance: "Bakiye yetersiz",
  CellCap: "Hücre limiti doldu",
  WindowCap: "Pencere limiti doldu",
  Capacity: "Kasa kapasitesi doldu",
  Session: "Oturum süresi doldu",
  SpendLimit: "Oturum harcama limiti doldu",
  RelayerBudget: "Relayer saatlik bütçesi doldu",
};

export async function tapCell(band: bigint, windowIdx: number) {
  const s = get();
  const { cfg, main } = s;
  if (!cfg || !main || !session || s.step !== "ready") return;
  const feed = cfg.feeds.find((f) => f.idx === s.feed)!;
  const nowSec = now() / 1000;
  if (!tappable(cfg, windowIdx, nowSec)) return;
  const key = `${s.feed}:${band}:${windowIdx}`;
  if (s.bets[key] && s.bets[key].status !== "rejected") return; // aynı hücreye ikinci bahis yok (UI sadeliği)
  const pts = series[s.feed];
  const last = pts[pts.length - 1];
  if (!last) return;
  const curBand = bandOf(last.raw, BigInt(feed.bandSize));
  const dist = Number(band > curBand ? band - curBand : curBand - band);
  const col = windowIdx - windowOf(nowSec, cfg.windowLen);
  const mult = multiplier(feed, dist, col);
  if (!mult) return;
  if (s.balance < s.stake) {
    toast("error", "Bakiye yetersiz — üstteki + ile yükle");
    return;
  }

  sfx.tap();
  const bet: LocalBet = { key, feed: s.feed, band, window: windowIdx, stake: s.stake, multBps: mult, status: "pending", confirmed: false, at: now() };
  set((st) => ({ bets: { ...st.bets, [key]: bet }, balance: st.balance - st.stake, sessionPnl: st.sessionPnl - st.stake }));

  try {
    const body = await signTap(cfg, session, {
      user: main.address,
      feedIdx: s.feed,
      bandIdx: band,
      windowIdx,
      stake: s.stake,
      minMultBps: Math.floor(mult * 0.85), // fiyat hücreye yaklaşırsa çarpan düşer: %15'ten fazlasını kabul etme
    });
    const r = await api.tap(body);
    if (r.status === "placed") {
      set((st) => {
        const cur = st.bets[key];
        // kazanç tespiti tx'ten önce gelmiş olabilir
        const status = cur?.status === "won" ? "won" : "placed";
        return { bets: { ...st.bets, [key]: { ...bet, ...cur, status, betId: r.betId, tx: r.tx, multBps: r.multBps, latencyMs: r.latencyMs } } };
      });
    } else {
      throw new Error(REASONS[r.reason] ?? r.reason);
    }
  } catch (e: any) {
    set((st) => ({ bets: { ...st.bets, [key]: { ...bet, status: "rejected", reason: e.message } }, balance: st.balance + st.stake, sessionPnl: st.sessionPnl + st.stake }));
    toast("error", e.message);
  }
}

export const setFeed = (feed: number) => set({ feed });
export const setStake = (stake: bigint) => set({ stake });
export const toggleMute = () => {
  set((s) => ({ muted: !s.muted }));
  sfx.muted = get().muted;
};
export type { BetRow };

/** Daha önce burner ile oynamışsa sayfa yenilendiğinde otomatik devam et (popup gerektirmez). */
export async function rememberedStart() {
  const { rememberedKind } = await import("./wallet");
  if (rememberedKind() === "burner" && get().step === "idle") await start("burner");
}
