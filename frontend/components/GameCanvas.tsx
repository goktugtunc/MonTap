"use client";
import { useEffect, useRef } from "react";
import { now, series, tapCell, useGame, type LocalBet } from "@/lib/game";
import { fmtUsd, multiplier, tappable, windowOf } from "@/lib/grid";

const C = {
  bg: "#0b0816",
  grid: "rgba(255,255,255,0.045)",
  text: "rgba(251,250,249,0.92)",
  dim: "rgba(251,250,249,0.38)",
  purple: [131, 110, 249] as const,
  berry: [232, 72, 170] as const,
  green: "#2ee59d",
  red: "rgba(255,90,110,0.9)",
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (t: number, a = C.purple, b = C.berry) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)].map(Math.round);
const fmtMult = (bps: number) => {
  const x = bps / 1e4;
  return x >= 10 ? `${Math.round(x)}x` : `${x.toFixed(x >= 3 ? 1 : 2)}x`;
};

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export default function GameCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const view = useRef({ center: NaN, layout: null as null | Layout });

  useEffect(() => {
    const cv = ref.current!;
    const g = cv.getContext("2d")!;
    let raf = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(g, W, H, view.current, hover.current);
    };
    raf = requestAnimationFrame(frame);

    const toLocal = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => (hover.current = toLocal(e));
    const onLeave = () => (hover.current = null);
    const onDown = (e: PointerEvent) => {
      const p = toLocal(e);
      const L = view.current.layout;
      if (!L) return;
      const cell = L.cellAt(p.x, p.y);
      if (cell) void tapCell(cell.band, cell.window);
    };
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerleave", onLeave);
    cv.addEventListener("pointerdown", onDown);
    return () => {
      cancelAnimationFrame(raf);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerleave", onLeave);
      cv.removeEventListener("pointerdown", onDown);
    };
  }, []);

  return <canvas ref={ref} className="game-canvas" aria-label="Fiyat grid'i: bir hücreye dokunarak bahis yap" />;
}

type Layout = { cellAt: (x: number, y: number) => { band: bigint; window: number } | null };

function draw(g: CanvasRenderingContext2D, W: number, H: number, v: { center: number; layout: Layout | null }, hover: { x: number; y: number } | null) {
  const st = useGame.getState();
  const cfg = st.cfg;
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  if (!cfg) return;
  const feed = cfg.feeds.find((f) => f.idx === st.feed);
  const pts = series[st.feed];
  if (!feed || !pts?.length) {
    g.fillStyle = C.dim;
    g.font = "500 14px ui-sans-serif, system-ui";
    g.textAlign = "center";
    g.fillText("Canlı fiyat bekleniyor…", W / 2, H / 2);
    return;
  }

  const t = now();
  const sec = t / 1000;
  const wl = cfg.windowLen;
  const bandSize = Number(feed.bandSize);
  // dar ekranda daha az ama okunur sütun (hücre ≥ ~70 px)
  const narrow = W < 640;
  const nowX = Math.round(W * (W < 480 ? 0.17 : narrow ? 0.22 : 0.3));
  const cols = narrow ? 5 : 9;
  const pps = (W - nowX) / (cols * wl); // piksel / sn
  const headerH = 26;
  const rowH = H < 320 ? 32 : H < 560 ? 40 : 48;
  const last = pts[pts.length - 1];
  const priceBand = (last.p * 1e8) / bandSize; // float bant koordinatı
  if (!Number.isFinite(v.center) || Math.abs(v.center - priceBand) > 40) v.center = priceBand;
  v.center = lerp(v.center, priceBand, 0.06);
  const cY = headerH + (H - headerH) / 2;
  const yOf = (bf: number) => cY - (bf - v.center) * rowH;
  const xOf = (s: number) => nowX + (s - sec) * pps;
  const curBand = BigInt(Math.floor(Number(last.raw) / bandSize));
  const curWin = windowOf(sec, wl);
  const bandTop = Math.ceil(v.center + (cY - headerH) / rowH) + 1;
  const bandBot = Math.floor(v.center - (H - cY) / rowH) - 1;

  // ---- geçmiş pencere çizgileri
  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  for (let w = curWin - Math.ceil(nowX / pps / wl) - 1; w <= curWin + cols + 1; w++) {
    const x = Math.round(xOf(w * wl)) + 0.5;
    g.beginPath();
    g.moveTo(x, headerH);
    g.lineTo(x, H);
    g.stroke();
  }
  for (let b = bandBot; b <= bandTop; b++) {
    const y = Math.round(yOf(b)) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }

  // ---- hücreler
  const betsByKey = st.bets;
  let hoverCell: { band: bigint; window: number; x: number; y: number; w: number; h: number } | null = null;
  const fs = Math.max(11, Math.min(14, rowH * 0.3));
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let w = curWin; w <= curWin + cols + 1; w++) {
    const x0 = xOf(w * wl);
    const x1 = xOf((w + 1) * wl);
    if (x1 < nowX) continue;
    const open = tappable(cfg, w, sec);
    const col = w - curWin;
    for (let b = bandBot; b <= bandTop; b++) {
      const band = BigInt(b);
      const y0 = yOf(b + 1);
      const y1 = yOf(b);
      const dist = Number(band > curBand ? band - curBand : curBand - band);
      const m = multiplier(feed, dist, col);
      const bet: LocalBet | undefined = betsByKey[`${st.feed}:${b}:${w}`];
      const cx = Math.max(x0, nowX) + 2;
      const cw = x1 - cx - 2;
      if (cw <= 2) continue;
      const cy = y0 + 2;
      const ch = rowH - 4;
      const isHover = !!hover && open && m > 0 && hover.x >= cx && hover.x <= cx + cw && hover.y >= cy && hover.y <= cy + ch;

      if (bet && bet.status !== "rejected") {
        drawBet(g, bet, cx, cy, cw, ch, fs);
        continue;
      }
      if (!m) continue;
      const k = Math.min(1, Math.log(m / 1e4) / Math.log(50));
      const [r, gg, bb] = mix(k);
      const a = open ? (isHover ? 0.42 : 0.07 + 0.16 * k) : 0.025;
      roundRect(g, cx, cy, cw, ch, 7);
      g.fillStyle = `rgba(${r},${gg},${bb},${a})`;
      g.fill();
      if (isHover) {
        g.strokeStyle = `rgba(${r},${gg},${bb},0.95)`;
        g.lineWidth = 1.5;
        g.stroke();
        hoverCell = { band, window: w, x: cx, y: cy, w: cw, h: ch };
      }
      if (cw > 26) {
        g.fillStyle = open ? `rgba(251,250,249,${0.5 + 0.45 * k})` : "rgba(251,250,249,0.14)";
        g.font = `600 ${fs}px ui-sans-serif, system-ui`;
        g.fillText(fmtMult(m), cx + cw / 2, cy + ch / 2);
      }
    }
  }

  // ---- fiyat çizgisi (geçmiş)
  const grad = g.createLinearGradient(0, 0, nowX, 0);
  grad.addColorStop(0, "rgba(131,110,249,0)");
  grad.addColorStop(1, "rgba(160,140,255,1)");
  g.beginPath();
  let started = false;
  for (const p of pts) {
    const x = nowX + ((p.t - t) / 1000) * pps;
    if (x < -10) continue;
    const y = yOf((p.p * 1e8) / bandSize);
    if (!started) {
      g.moveTo(x, y);
      started = true;
    } else g.lineTo(x, y);
  }
  const headY = yOf(priceBand);
  g.lineTo(nowX, headY);
  g.strokeStyle = grad;
  g.lineWidth = 2.5;
  g.shadowColor = "rgba(131,110,249,0.8)";
  g.shadowBlur = 12;
  g.stroke();
  g.shadowBlur = 0;

  // ---- şimdi çizgisi + fiyat
  g.strokeStyle = "rgba(251,250,249,0.18)";
  g.setLineDash([3, 4]);
  g.beginPath();
  g.moveTo(nowX + 0.5, headerH);
  g.lineTo(nowX + 0.5, H);
  g.moveTo(nowX, headY);
  g.lineTo(W, headY);
  g.stroke();
  g.setLineDash([]);
  const pulse = 4 + Math.sin(t / 180) * 1.5;
  g.fillStyle = "rgba(131,110,249,0.25)";
  g.beginPath();
  g.arc(nowX, headY, pulse + 6, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fbfaf9";
  g.beginPath();
  g.arc(nowX, headY, 4.5, 0, Math.PI * 2);
  g.fill();

  const label = `$${fmtUsd(last.p)}`;
  g.font = "700 13px ui-sans-serif, system-ui";
  const lw = g.measureText(label).width + 16;
  const lx = Math.max(4, nowX - lw - 10);
  roundRect(g, lx, headY - 12, lw, 24, 8);
  g.fillStyle = "#836ef9";
  g.fill();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.fillText(label, lx + lw / 2, headY + 0.5);

  // ---- üst başlık: pencereye kalan süre
  g.fillStyle = "rgba(11,8,22,0.92)";
  g.fillRect(0, 0, W, headerH);
  g.font = "600 11px ui-sans-serif, system-ui";
  for (let w = curWin; w <= curWin + cols + 1; w++) {
    const x0 = xOf(w * wl);
    const x1 = xOf((w + 1) * wl);
    if (x1 < nowX + 20) continue;
    const dt = w * wl - sec;
    g.fillStyle = tappable(cfg, w, sec) ? C.dim : "rgba(255,90,110,0.55)";
    g.fillText(dt > 0 ? `+${Math.ceil(dt)}s` : "şimdi", (Math.max(x0, nowX) + x1) / 2, headerH / 2);
  }

  // ---- fiyat ekseni: sol (geçmiş) alanda, hücrelerin üstüne binmez
  g.textAlign = "left";
  g.font = "500 10px ui-sans-serif, system-ui";
  g.fillStyle = "rgba(251,250,249,0.3)";
  const step = narrow ? 4 : 2;
  for (let b = bandBot; b <= bandTop; b++) {
    if (b % step) continue;
    const y = yOf(b);
    if (y < headerH + 8 || y > H - 4 || Math.abs(y - headY) < 16) continue;
    g.fillText(`$${fmtUsd((b * bandSize) / 1e8)}`, 6, y - 5);
  }

  v.layout = {
    cellAt: (x, y) => {
      if (x < nowX || y < headerH) return null;
      const s = sec + (x - nowX) / pps;
      const w = windowOf(s, wl);
      const b = Math.floor(v.center + (cY - y) / rowH);
      if (!tappable(cfg, w, now() / 1000)) return null;
      return { band: BigInt(b), window: w };
    },
  };
  void hoverCell;
}

function drawBet(g: CanvasRenderingContext2D, b: LocalBet, x: number, y: number, w: number, h: number, fs: number) {
  const t = Date.now();
  roundRect(g, x, y, w, h, 7);
  const label = `${(Number(b.stake) / 1e6).toFixed(0)} · ${(b.multBps / 1e4).toFixed(2)}x`;
  if (b.status === "pending") {
    g.fillStyle = "rgba(131,110,249,0.25)";
    g.fill();
    g.setLineDash([4, 3]);
    g.lineDashOffset = -t / 40;
    g.strokeStyle = "rgba(251,250,249,0.85)";
    g.lineWidth = 1.5;
    g.stroke();
    g.setLineDash([]);
  } else if (b.status === "placed") {
    g.fillStyle = "rgba(131,110,249,0.88)";
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.6)";
    g.lineWidth = 1;
    g.stroke();
  } else if (b.status === "won") {
    g.fillStyle = "rgba(46,229,157,0.9)";
    g.fill();
    const age = (t - (b.wonAt ?? t)) / 1000;
    if (age < 1.2) {
      g.strokeStyle = `rgba(46,229,157,${1 - age / 1.2})`;
      g.lineWidth = 3;
      roundRect(g, x - age * 22, y - age * 22, w + age * 44, h + age * 44, 10);
      g.stroke();
    }
  } else if (b.status === "lost") {
    g.fillStyle = "rgba(255,255,255,0.06)";
    g.fill();
  }
  if (w > 30) {
    g.font = `700 ${fs}px ui-sans-serif, system-ui`;
    g.textAlign = "center";
    g.fillStyle = b.status === "lost" ? "rgba(251,250,249,0.3)" : b.status === "won" ? "#05261a" : "#fff";
    const text = b.status === "won" ? `+${(Number((b.stake * BigInt(b.multBps)) / 10_000n) / 1e6).toFixed(2)}` : label;
    g.fillText(text, x + w / 2, y + h / 2 + (b.confirmed && b.status === "won" ? -6 : 0));
    if (b.status === "won" && b.confirmed) {
      g.font = `600 ${fs - 3}px ui-sans-serif, system-ui`;
      g.fillText("onchain ✓", x + w / 2, y + h / 2 + 9);
    }
  }
}
