/** Küçük WebAudio sesleri (dosya yok). İlk kullanıcı etkileşiminde AudioContext açılır. */
let ctx: AudioContext | undefined;
const ac = () => {
  if (typeof window === "undefined") return undefined;
  ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
};

function tone(freq: number, dur: number, type: OscillatorType = "sine", gain = 0.06, slideTo?: number, delay = 0) {
  const c = ac();
  if (!c || sfx.muted) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur);
}

export const sfx = {
  muted: false,
  tap: () => tone(660, 0.08, "triangle", 0.05, 880),
  win: () => {
    tone(523, 0.12, "triangle", 0.07);
    tone(659, 0.12, "triangle", 0.07, undefined, 0.08);
    tone(988, 0.22, "triangle", 0.07, undefined, 0.16);
  },
  ready: () => tone(440, 0.18, "sine", 0.05, 880),
};
