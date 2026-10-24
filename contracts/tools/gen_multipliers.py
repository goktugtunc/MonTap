"""Hücre çarpan tablosunu Monte Carlo ile üretir.

Model: GBM, `dt` saniyede bir örneklenen Pyth fiyatı. Hücre (mesafe d, kolon c) için:
  P = P(penceredeki herhangi bir örnek fiyatı, şu anki banttan d uzaklıktaki bantta)
Mevcut fiyatın bant içindeki konumu ve şu anki pencere içindeki zaman düzgün rastgele.
Kontrattaki kural: pencere başı ≥ şimdi + minLead.

çarpan = min(maxMult, (1 − edge) / P)   → bps; çarpan < 1.01x ise hücre kapalı (0).

Sağlamlık: tek bir oynaklık yerine [volLo, volHi] aralığında birkaç değer denenir ve her hücre için EN YÜKSEK
olasılık (→ en düşük çarpan) alınır. Sakin piyasada merkez hücreler, hareketli piyasada uzak hücreler daha sık
kazanır; aralığın tamamına karşı fiyatlamak kasayı iki yönde de korur.

Kullanım: python3 tools/gen_multipliers.py <feed> <volLo> <volHi> <bandBps> > deployments/mult.<feed>.json
"""
import json
import sys

import numpy as np

DIST, COLS = 16, 12
W, MIN_LEAD, DT = 5.0, 3.0, 0.25
EDGE, MAX_MULT, MIN_MULT = 0.05, 50.0, 1.01
N = 40_000


def table(annual_vol: float, band_bps: float, seed: int = 7) -> list[list[int]]:
    rng = np.random.default_rng(seed)
    sigma = annual_vol / np.sqrt(365 * 24 * 3600)  # saniye başı log-vol
    band = band_bps / 10_000  # bandın göreli genişliği
    steps = int((COLS + 1) * W / DT) + 1

    u = rng.uniform(0, W, N)  # şu anki pencere içindeki zaman
    x0 = rng.uniform(0, 1, N)  # fiyatın bant içindeki konumu (bant birimi)
    z = rng.standard_normal((N, steps)) * sigma * np.sqrt(DT) / band
    path = x0[:, None] + np.cumsum(z, axis=1)  # bant biriminde log fiyat
    bands = np.floor(path).astype(np.int64)
    t = (np.arange(steps) + 1) * DT  # örnek zamanları (şimdiden itibaren)

    out = [[0] * COLS for _ in range(DIST)]
    for c in range(COLS):
        start = c * W - u  # pencere başlangıcına kalan süre (her örnek için)
        valid = start >= MIN_LEAD
        if valid.sum() < 1000:
            continue
        in_win = (t[None, :] >= start[:, None]) & (t[None, :] < start[:, None] + W)
        for d in range(DIST):
            # simetri: +d ve −d bantları ortalaması
            hit_up = ((bands == d) & in_win).any(axis=1)
            hit_dn = ((bands == -d) & in_win).any(axis=1)
            p = (hit_up[valid].mean() + hit_dn[valid].mean()) / 2
            if p <= 0:
                mult = MAX_MULT
            else:
                mult = min(MAX_MULT, (1 - EDGE) / p)
            out[d][c] = int(mult * 10_000) if mult >= MIN_MULT else 0
    return out


def robust(vol_lo: float, vol_hi: float, band_bps: float, steps: int = 5) -> list[list[int]]:
    vols = [vol_lo * (vol_hi / vol_lo) ** (i / (steps - 1)) for i in range(steps)]
    tables = [table(v, band_bps, seed=7 + i) for i, v in enumerate(vols)]
    # çarpan ∝ 1/P → en yüksek olasılık = en düşük çarpan; 0 (kapalı) her zaman kazanır
    out = [[0] * COLS for _ in range(DIST)]
    for d in range(DIST):
        for c in range(COLS):
            vals = [t[d][c] for t in tables]
            out[d][c] = 0 if 0 in vals else min(vals)
    return out


if __name__ == "__main__":
    feed, lo, hi, band_bps = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    tb = robust(lo, hi, band_bps)
    json.dump({"feed": feed, "volLo": lo, "volHi": hi, "bandBps": band_bps, "table": tb}, sys.stdout)
