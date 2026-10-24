"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { cashOut, setFeed, setStake, start, toggleMute, topUp, useGame } from "@/lib/game";
import { fmtUsd, fmtUsdc, short } from "@/lib/grid";
import { hasInjected } from "@/lib/wallet";

const STAKES = [1, 5, 10, 25].map((x) => BigInt(x) * 1_000_000n);

export function TopBar() {
  const { cfg, feed, lastPrice, balance, main, step, muted } = useGame();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>
          ◆
        </span>
        <span>MonTap</span>
        <span className="chip chip-net">Monad testnet</span>
      </div>
      <nav className="feeds" aria-label="Varlık">
        {cfg?.feeds.map((f) => (
          <button key={f.idx} className={`feed ${feed === f.idx ? "on" : ""}`} onClick={() => setFeed(f.idx)}>
            <b>{f.symbol}</b>
            <span>{lastPrice[f.idx] ? `$${fmtUsd(lastPrice[f.idx])}` : "…"}</span>
          </button>
        ))}
      </nav>
      <div className="wallet">
        <button className="icon mute" onClick={toggleMute} aria-label={muted ? "Sesi aç" : "Sesi kapat"} title={muted ? "Sesi aç" : "Sesi kapat"}>
          {muted ? "🔇" : "🔊"}
        </button>
        {step === "ready" && main ? (
          <>
            <div className="balance" title="Oyun bakiyesi">
              <span>{fmtUsdc(balance)}</span>
              <small>tUSDC</small>
            </div>
            <button className="icon plus" onClick={() => void topUp()} title="Faucet'ten 100 tUSDC yükle" aria-label="Bakiye yükle">
              +
            </button>
            <a className="addr" href={`${cfg?.explorer}/address/${main.address}`} target="_blank" rel="noreferrer" title={main.kind === "burner" ? "Tarayıcı cüzdanı" : "Bağlı cüzdan"}>
              {short(main.address)}
            </a>
          </>
        ) : null}
      </div>
    </header>
  );
}

const STEPS: { id: string; label: string }[] = [
  { id: "wallet", label: "Cüzdan" },
  { id: "faucet", label: "Test USDC" },
  { id: "deposit", label: "Yatırma (gassız)" },
  { id: "session", label: "Oturum anahtarı" },
];

export function Onboarding() {
  const { step, stepError, cfg } = useGame();
  // window.ethereum sadece tarayıcıda var → SSR ile aynı ilk render için mount sonrası oku
  const [injected, setInjected] = useState(false);
  useEffect(() => setInjected(hasInjected()), []);
  if (step === "ready") return null;
  const busy = step !== "idle" && step !== "error";
  const idx = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="overlay">
      <div className="card onboard">
        <h1>
          Fiyata <em>dokun</em>, kazan.
        </h1>
        <p className="lead">
          Grid'deki bir hücreye dokun: fiyat o 5 saniyelik pencerede o banda girerse bahsin çarpanla geri döner. Her dokunuş Monad'da bir
          işlem, ~300 ms'de onaylanıyor. Cüzdan popup'ı yok, gas yok.
        </p>
        {busy ? (
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className={i < idx ? "done" : i === idx ? "now" : ""}>
                <span className="dot" />
                {s.label}
              </li>
            ))}
          </ol>
        ) : (
          <div className="cta">
            <button className="btn primary" disabled={!cfg} onClick={() => void start("burner")}>
              Hemen oyna
            </button>
            {injected && (
              <button className="btn" disabled={!cfg} onClick={() => void start("injected")}>
                Cüzdan bağla
              </button>
            )}
          </div>
        )}
        {step === "error" && <p className="err">Bir şey ters gitti: {stepError}</p>}
        <p className="fine">
          Test ağı · tUSDC değersiz test token'ıdır · "Hemen oyna" tarayıcında bir cüzdan oluşturur.
        </p>
      </div>
    </div>
  );
}

export function BottomBar() {
  const { stake, sessionPnl, bets, step } = useGame();
  const open = useMemo(() => Object.values(bets).filter((b) => b.status === "placed" || b.status === "pending").length, [bets]);
  return (
    <footer className="bottombar">
      <div className="stakes" role="radiogroup" aria-label="Bahis tutarı">
        {STAKES.map((s) => (
          <button key={s.toString()} role="radio" aria-checked={stake === s} className={`stake ${stake === s ? "on" : ""}`} onClick={() => setStake(s)}>
            {Number(s) / 1e6}
          </button>
        ))}
        <span className="unit">tUSDC</span>
      </div>
      {step === "ready" && (
        <div className="session">
          <span className="open-count">
            Açık <b>{open}</b>
          </span>
          <span className={sessionPnl >= 0n ? "pos" : "neg"}>
            Oturum {sessionPnl >= 0n ? "+" : ""}
            {fmtUsdc(sessionPnl)}
          </span>
          <button className="link" onClick={() => void cashOut()}>
            Çek
          </button>
        </div>
      )}
    </footer>
  );
}

export function SidePanel() {
  const [tab, setTab] = useState<"speed" | "bets" | "board">("speed");
  // mobilde panel alt çekmece: varsayılan kapalı, aktif sekmeye dokununca aç/kapa (masaüstünde CSS hep açık tutar)
  const [open, setOpen] = useState(false);
  const pick = (id: typeof tab) => {
    if (id === tab) setOpen((o) => !o);
    else {
      setTab(id);
      setOpen(true);
    }
  };
  return (
    <aside className={`side ${open ? "open" : "closed"}`}>
      <div className="tabs" role="tablist">
        {(
          [
            ["speed", "Monad hızı"],
            ["bets", "Bahislerim"],
            ["board", "Sıralama"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => pick(id)}>
            {label}
          </button>
        ))}
        <button className="drawer-toggle" onClick={() => setOpen((o) => !o)} aria-label={open ? "Paneli kapat" : "Paneli aç"} aria-expanded={open}>
          {open ? "▾" : "▴"}
        </button>
      </div>
      {tab === "speed" ? <Speed /> : tab === "bets" ? <MyBets /> : <Board />}
    </aside>
  );
}

function Speed() {
  const { txs, cfg } = useGame();
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>>>();
  useEffect(() => {
    const f = () => api.stats().then(setStats).catch(() => {});
    f();
    const id = setInterval(f, 5000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="panel">
      <div className="kpis">
        <div>
          <b>300 ms</b>
          <span>blok süresi</span>
        </div>
        <div>
          <b>{stats?.txLatency ? `${stats.txLatency.p50} ms` : "—"}</b>
          <span>onay (p50)</span>
        </div>
        <div>
          <b>{stats?.bets ?? "—"}</b>
          <span>onchain bahis</span>
        </div>
      </div>
      <ul className="txs">
        {txs.length === 0 && <li className="empty">İlk dokunuşu bekliyor…</li>}
        {txs.map((t) => (
          <li key={t.hash}>
            <span className={`dot ${t.status === "success" ? "ok" : "bad"}`} />
            <span className="lbl">{t.label}</span>
            <span className="ms">{t.latencyMs} ms</span>
            <a href={`${cfg?.explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">
              {t.hash.slice(0, 8)}↗
            </a>
          </li>
        ))}
      </ul>
      <p className="fine">
        Fiyat: Binance, Coinbase, OKX, Bybit, Kraken medyanı; 250 ms'de bir imzalanır, zincir üstünde Pyth fiyatından sapma kontrol edilir.
        Settlement izinsiz: kanıtı herkes sunabilir.
      </p>
    </div>
  );
}

function MyBets() {
  const { bets, cfg } = useGame();
  const list = useMemo(() => Object.values(bets).sort((a, b) => b.at - a.at).slice(0, 30), [bets]);
  if (!list.length) return <div className="panel empty">Henüz bahis yok — grid'e dokun.</div>;
  return (
    <div className="panel">
      <ul className="bets">
        {list.map((b) => (
          <li key={b.key} className={b.status}>
            <span className="sym">{cfg?.feeds.find((f) => f.idx === b.feed)?.symbol}</span>
            <span>
              {fmtUsdc(b.stake)} × {(b.multBps / 1e4).toFixed(2)}
            </span>
            <span className="st">
              {b.status === "won" ? `+${fmtUsdc((b.stake * BigInt(b.multBps)) / 10_000n)}` : { pending: "gönderiliyor", placed: "açık", lost: "kaybetti", rejected: "reddedildi" }[b.status]}
            </span>
            {b.tx ? (
              <a href={`${cfg?.explorer}/tx/${b.settledTx ?? b.tx}`} target="_blank" rel="noreferrer" title={b.latencyMs ? `${b.latencyMs} ms` : undefined}>
                ↗
              </a>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Board() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.leaderboard>>>([]);
  const me = useGame((s) => s.main?.address.toLowerCase());
  useEffect(() => {
    const f = () => api.leaderboard().then(setRows).catch(() => {});
    f();
    const id = setInterval(f, 10_000);
    return () => clearInterval(id);
  }, []);
  if (!rows.length) return <div className="panel empty">Son 24 saatte sonuçlanmış bahis yok.</div>;
  return (
    <div className="panel">
      <ol className="board">
        {rows.map((r, i) => (
          <li key={r.user_addr} className={r.user_addr === me ? "me" : ""}>
            <span className="rank">{i + 1}</span>
            <span className="who">{short(r.user_addr)}</span>
            <span className="n">
              {r.wins}/{r.bets}
            </span>
            <span className={Number(r.pnl) >= 0 ? "pos" : "neg"}>
              {Number(r.pnl) >= 0 ? "+" : ""}
              {fmtUsdc(r.pnl)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
