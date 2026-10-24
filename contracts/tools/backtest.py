"""Çarpan tablosunu gerçek tick yoluna karşı sınar: her hücrenin beklenen getirisi (EV = P × çarpan).
EV > 1 olan hücre kasanın aleyhine. Kullanım: python3 tools/backtest.py <archive.txt> <mult.json> <bandSizeUnits>"""
import bisect
import json
import sys

W, MIN_LEAD = 5.0, 3.0 + 1.5  # relayer ön kontrol payıyla
arch, mult_path, band_size = sys.argv[1], sys.argv[2], int(sys.argv[3])
pts = sorted((int(a), int(b)) for a, b in (l.strip().split(",") for l in open(arch) if "," in l))
ts = [p[0] for p in pts]
table = json.load(open(mult_path))["table"]

def price_at(t):
    return pts[max(0, bisect.bisect_right(ts, t) - 1)][1]

hits = {}
n = {}
t = ts[0] + 1000
end = ts[-1] - 70_000
while t < end:
    cur_band = price_at(t) // band_size
    cur_win = (t // 1000) // 5
    for c in range(1, 12):
        ws = (cur_win + c) * 5 * 1000
        if ws < t + MIN_LEAD * 1000:
            continue
        # pencere içindeki fiyatlar: başlangıçtaki geçerli fiyat + pencere içindeki değişimler
        i0 = bisect.bisect_left(ts, ws)
        i1 = bisect.bisect_left(ts, ws + 5000)
        bands = {price_at(ws) // band_size} | {pts[i][1] // band_size for i in range(i0, i1)}
        for d in range(16):
            for sgn in ((1,) if d == 0 else (1, -1)):
                k = (d, c)
                n[k] = n.get(k, 0) + 1
                if cur_band + sgn * d in bands:
                    hits[k] = hits.get(k, 0) + 1
    t += 1000

worst = []
for (d, c), cnt in n.items():
    m = table[d][c] / 1e4
    if not m:
        continue
    p = hits.get((d, c), 0) / cnt
    worst.append((p * m, d, c, p, m, cnt))
worst.sort(reverse=True)
print(f"{len(pts)} tick, {(ts[-1]-ts[0])/60000:.0f} dk; en yüksek EV'li hücreler:")
for ev, d, c, p, m, cnt in worst[:6]:
    print(f"  d={d:2} c={c:2}  P={p:.3f}  çarpan={m:.2f}  EV={ev:.3f}  (n={cnt})")
print("EV>1 hücre sayısı:", sum(1 for w in worst if w[0] > 1))
