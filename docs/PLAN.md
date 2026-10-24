# MonTap — Monad üzerinde tap-trading

> Canlı fiyat grafiğinin üstünde fiyat bandı × zaman penceresi hücrelerinden oluşan bir grid.
> Kullanıcı bir hücreye dokunur, o pencerede Pyth fiyatı banda girerse `bahis × çarpan` kazanır.
> Cüzdan popup'ı yok, gas ödemesi yok; her dokunuş onchain bir bahis.

Teknik referans: [`monad-dev-research.md`](./monad-dev-research.md)

**Durum (24 Eki 2026):** Faz 0–5 tamam. Canlı: https://monfront.isinigetir.com. Privy entegrasyonu App ID gelince eklenecek (şimdilik burner + tarayıcı cüzdanı).

---

## 0. Temel kararlar

| Konu | Karar | Neden |
|---|---|---|
| Ağ | **Monad testnet** (chain `10143`) | Faucet var, mainnet ile aynı protokol. Jüri istersen mainnet'e (`143`) aynı script ile deploy |
| Teminat | **Test USDC** `0x534b…43A3` | Kullanıcı MON tutmak zorunda kalmaz; Circle faucet 20 USDC/2 saat; `permit` ile gassız deposit |
| Varlık | **BTC/USD** (Pyth) ilk; MON/USD ikinci | BTC en likit ve sık güncellenen feed; MON "Monad yerlisi" hikâyesi için |
| Oracle | **Pyth pull** — `0x2880…7B43`, update fee = 0 | Hermes için API key gerekli (sunucuda tutulur) |
| UX | **Privy embedded wallet + session key + relayer** | ERC-4337 bundler'a gerek yok, kullanıcı MON tutmaz, 10 MON (7702) kuralı devreye girmez |
| Settlement | **Permissionless**: kim olursa olsun pencere içi Pyth update'i ile settle edebilir | Keeper'a güven gerekmez; jüriye "trustless" anlatılır |
| Çarpanlar | **Onchain tablo** `multiplier[satır][sütun]`, admin volatiliteye göre günceller | Onchain normal-CDF yok, imzalı quote servisi yok → en az parça |

### Faz 1'de netleşenler (plandan farklar)

- **Teminat: MockUSDC (tUSDC)** — permit'li, herkes 1000'e kadar basabilir; jüri faucet beklemeden oynar. Gerçek test USDC için `USDC_ADDRESS` env'i yeterli.
- **Oracle: MonTap imzalı oracle (v2)** — Hermes artık ücretli API key istiyor, zincir üstü Pyth push testnet'te ~7 sn'de bir güncelleniyor (5 sn pencereler için yetersiz). Backend Binance/Coinbase/OKX/Bybit medyanını ~250 ms'de bir EIP-712 ile imzalar (`PriceTick(feedIdx, price, timestampMs)`); kontrat imzayı ve **zincir üstü Pyth push fiyatından sapmayı** (BTC %1, MON %2) kontrol eder. ms hassasiyetli pencere sınırları. Tüm tick'ler WS'den herkese açık yayınlanır (denetlenebilirlik). Üretimde Pyth Pro'ya geçiş yol haritasında.
- **Pyth testnet: "Compatible" kontrat `0xFC6bd9F9…d379`** — sadece sapma kontrolünün referansı olarak.
- **`placeBets` izinsiz** — relayer rolü yok. Güvenlik session imzası + bitmap nonce + `minMultBps` ile; ayrıca `placeBetsDirect` ile relayer'sız oynanabilir.
- **Grid mutlak:** band `[i·bandSize, (i+1)·bandSize)`, pencere `[j·5, (j+1)·5)`. Çarpan = `tablo[|i − şimdikiBand|][j − şimdikiPencere]`, referans fiyat aynı tx'teki Pyth update'inden.
- **Kasa:** `totalAssets = bakiye − rezerv` (en kötü senaryo), LP payları transfer edilemez, sadece kendi adına yatırım, 120 sn cooldown.
- **Ölçülen gas:** tap başı ~118k, 20 tap'lik batch ~2.37M.

### Hücre semantiği

- **Satır (price band):** referans fiyata göre ±`k × bandBps` (ör. band = 5 bps). Referans fiyat bahis anında batch'e eklenen taze Pyth update'inden **onchain** okunur.
- **Sütun (time window):** `[t0 + delay + i·W, t0 + delay + (i+1)·W)` — `W = 5 sn`, `delay = 3 sn`.
  `block.timestamp` saniye çözünürlüklü olduğu için pencereler saniye bazlı tutuluyor (3–4 blok aynı timestamp'i paylaşıyor).
- **Kazanma:** `publishTime ∈ [windowStart, windowEnd)` olan herhangi bir Pyth fiyatı `[low, high]` bandına düşerse.
- **Kaybetme:** `windowEnd + grace (10 sn)` sonrası kimse kazanma kanıtı sunmadıysa herkes `expire` edebilir.

### Çarpan matematiği (tablonun kaynağı)

Backend tablo üretir, admin `setMultipliers` ile yazar:

```
P(band'e değme) ≈ 2·(1 − Φ(d / (σ·√t)))      d: banda uzaklık, t: pencere sonuna süre
multiplier = min( (1/P) × (1 − houseEdge), maxMultiplier )   houseEdge = %5, max = 50x
```

---

## 1. Mimari

```
┌──────────── Frontend (Next.js, monfront) ────────────┐
│ Canvas grid + canlı grafik · Privy login · session key│
│ tap → EIP-712 imza (session key)                      │
└──────────────┬──────────────────────────▲─────────────┘
               │ POST /tap                 │ WS: fiyat, bahis durumu
┌──────────────▼──────────────────────────┴─────────────┐
│ Backend (Fastify + ws, monback)                        │
│  price-stream: Hermes SSE → Redis pub/sub → WS         │
│  relayer: 300 ms batch → placeBetsBySig (tek tx)       │
│  indexer: monadLogs/newHeads → Postgres                │
│ Keeper (ayrı container)                                │
│  touch-detector: Hermes akışı × açık bahisler          │
│  settleWin(kanıt) / expire                             │
└──────────────┬────────────────────────────────────────┘
               │ eth_sendRawTransactionSync
┌──────────────▼────────────────────────────────────────┐
│ Monad: TapMarket ── HouseVault ── Pyth ── USDC         │
└───────────────────────────────────────────────────────┘
```

---

## 2. Fazlar

### Faz 0 — DevOps ✅ (tamam)
- Docker Compose: frontend, backend, keeper (profile), postgres, redis
- Nginx + Let's Encrypt: `monfront` → `:4200`, `monback` → `:4201` (+ `/ws`)
- `deploy/deploy.sh`: rsync + `compose up -d --build`

### Faz 1 — Akıllı kontratlar (Foundry)  ⏱ ~8–10 saat

**Toolchain:** Foundry ≥1.8, `solc 0.8.31`, `evm_version = "osaka"`, `network = "monad"`, OpenZeppelin v5, Pyth SDK.

**`HouseVault.sol`** — LP kasası (ERC-4626 benzeri, USDC)
- `deposit / requestWithdraw / withdraw` — çekim **gecikmeli** (en uzun pencereden uzun, ör. 2 dk) → LP'ler gördükleri bir touch'tan önce kaçamaz
- `reserve(amount)` / `release(amount)` / `payout(to, amount)` — sadece TapMarket
- `freeLiquidity = totalAssets − reserved`; LP payı hesabı reserved'ı hesaba katar

**`TapMarket.sol`** — bahis motoru
- Kullanıcı bakiyesi (internal ledger): `depositWithPermit`, `withdraw`
- Oturum: `registerSession(user, sessionKey, maxSpend, expiry, userSig)` — EIP-712 `SessionGrant`
- `placeBetsBySig(Tap[] taps, bytes[] sigs, bytes[] priceUpdate)` — relayer çağırır:
  1. Pyth update → referans fiyat (`publishTime ≥ block.timestamp − 2`)
  2. Her tap: session imzası, nonce, harcama limiti, hücre (`row`, `col`) geçerliliği
  3. `payout = amount × multiplier[row][col]` → vault'tan **rezerve**
  4. Limitler: bahis başı max, hücre başı max, pencere başı max, toplam exposure ≤ freeLiquidity × %X
- `settleWin(betIds[], updateData)` — `parsePriceFeedUpdates(update, feed, windowStart, windowEnd − 1)` → fiyat bantta mı → ödeme, rezerv serbest
- `expire(betIds[])` — `block.timestamp ≥ windowEnd + grace` → kayıp, stake vault'a
- Admin: `setMultipliers`, `setLimits`, `pause`

**Monad'a özel optimizasyonlar**
- Bahisler **packed `Bet[]` dizisi** (2 slot/bahis) → MIP-8 sayfa fiyatlaması sayesinde ardışık bahisler aynı 128-slot sayfayı paylaşır
- `uint64` timestamp, `uint96` tutar, `int64` fiyat paketleme
- Event'ler zengin (`BetPlaced`, `BetWon`, `BetExpired`) → indexer'ın `getLogs` 100 blok sınırına takılmadan WS ile beslenmesi

**Testler**
- Birim: imza/nonce/limit/pencere sınırları, geç bahis, yanlış pencereden kanıt, çift settle
- Fuzz: vault solvency invariantı — `totalAssets ≥ reserved` her zaman
- Pyth `MockPyth` ile deterministik fiyat senaryoları
- Testnet deploy + Sourcify/Monadscan verify scripti (`script/Deploy.s.sol`)

**Çıktı:** testnet'te verify edilmiş 2 kontrat, adresler `.env`'de, ABI'ler `shared/abi`'de.

### Faz 2 — Backend çekirdek  ⏱ ~6–8 saat

**Stack:** Node 22, TypeScript, Fastify, `ws`, viem, Drizzle + Postgres, ioredis.

- **price-stream:** Hermes SSE (BTC, MON) → normalize → Redis pub/sub → WS `price` kanalı (~400 ms güncelleme). Grafik geçmişi için Redis'te son 10 dk ring buffer.
- **relayer:**
  - `POST /tap` → imza ön kontrolü → kuyruk
  - 300 ms'de bir (veya 20 tap'te) batch → taze Pyth update ile `placeBetsBySig`
  - **Hardcoded gas limit** (+%10) — Monad gas *limit* üzerinden ücret alır, `estimateGas` kullanma
  - **Lokal nonce yöneticisi** (public mempool yok; nonce gap'ler sessizce kabul edilebiliyor)
  - `eth_sendRawTransactionSync` → ~300 ms'de makbuz → WS ile kullanıcıya `bet:placed`
  - 2–3 relayer anahtarı rotasyonu, her biri **>10 MON** (reserve balance kuralı)
- **API:** `/session` (grant kaydı), `/me` (bakiye, açık bahisler), `/leaderboard`, `/multipliers`, `/health`
- **Postgres şeması:** `users`, `sessions`, `bets`, `settlements`, `price_ticks` (opsiyonel)

### Faz 3 — Keeper + indexer  ⏱ ~4–5 saat

- **indexer:** `monadLogs` aboneliği (commit state içerir) → `proposed` olarak yaz, `finalized` gelince kesinleştir; düşen bloklar için yeniden mutabakat
- **touch-detector:** açık bahisler (pencere → band) bellekte; her Hermes tick'inde eşleşme → o update'in **binary verisini** sakla → `settleWin` batch
- **expirer:** süresi + grace geçen bahisleri 1 sn'de bir topla → `expire`
- Ayrı container (`--profile keeper`), ayrı anahtar, ayrı RPC sağlayıcı (public RPC tutarsızlığı)

### Faz 4 — Frontend  ⏱ ~8–10 saat

**Stack:** Next.js 15 (App Router, standalone), Tailwind, Privy, viem, Zustand, Canvas 2D (grid + grafik tek canvas'ta, 60 fps).

- **Onboarding (≤30 sn):** Privy (e-posta/Google) → embedded wallet → "Faucet'ten USDC al" butonu → `permit` + deposit (gassız) → session grant imzası (tek seferlik)
- **Oyun ekranı (mobil öncelikli):**
  - Sağa akan canlı fiyat çizgisi; sağda gelecek pencerelerin grid'i, her hücrede çarpan
  - Dokun → hücre anında "bekliyor" (optimistik) → ~300 ms sonra "onchain ✓" + tx linki
  - Fiyat çizgisi hücreye girince patlama animasyonu + ses + bakiye sayacı
  - Bahis tutarı seçici (1/5/10 USDC), varlık seçici (BTC / MON)
- **Yan panel ("Monad hızı"):** canlı tx akışı, ortalama onay süresi (ms), MonadVision linkleri — demonun jüri kozu
- **LP sayfası:** vault'a yatır, APR / PnL, kasanın açık riski
- **Leaderboard:** günlük PnL

### Faz 5 — Entegrasyon, demo, pitch  ⏱ ~4 saat

- Uçtan uca testnet senaryosu; yük testi (100 tap/sn script'i → "X tap/sn onchain" metriği)
- Vault'a seed likidite, demo hesapları önceden fonlanmış
- Ağ/Hermes kopmalarına karşı UI fallback'leri
- 2–3 dk demo akışı + yedek ekran kaydı
- README, mimari diyagram, kontrat adresleri, pitch deck

---

## 3. Toplam süre ve kritik yol

```
Faz 1 kontrat ───────────┐
                         ├──► Faz 3 keeper ──┐
Faz 2 backend (mock ABI) ┘                   ├──► Faz 5
Faz 4 frontend (mock WS) ────────────────────┘
```

Tek kişi: ~30–35 saat. 2–3 kişi: kontrat / backend / frontend paralel, ~15–18 saat.
**Kesilebilecekler (süre daralırsa):** LP sayfası, leaderboard, MON feed'i, indexer'ın finality mutabakatı.

## 4. Bilinen riskler

| Risk | Önlem |
|---|---|
| Pyth fiyatı örneklemeli — gerçek fiyat banda girip Pyth yayınında görünmeyebilir | UI'da "Pyth fiyatı esas alınır" yazıyor; band genişliği güncelleme sıklığına göre ayarlı |
| Geç bahis (fiyatı görüp oynamak) | Pencere ≥3 sn sonra başlıyor; kanıt `publishTime ≥ windowStart` olmak zorunda |
| Kasa batması | Bahis anında max payout rezervi + hücre/pencere/toplam limitler + gecikmeli LP çekimi |
| Public RPC tutarsızlığı / 25 rps limiti | Relayer ve keeper için ayrı özel RPC (Alchemy/QuickNode vb.) |
| Hermes API key / kesinti | Key sunucuda; kopmada UI grid'i kilitler |
| Proposed blok verisinin değişmesi | UI "onchain ✓" için proposed yeterli; bakiye/ödeme finalized'a göre |

## 5. Senden lazım olanlar

1. **Hackathon detayları:** bitiş saati, takım boyutu, track/sponsor ödülleri (Pyth, Privy vb. ödül varsa entegrasyonu ona göre öne çıkarırız), mainnet şartı var mı
2. **Pyth Hermes API key** — pythdata.app
3. **Privy App ID** — dashboard.privy.io (ücretsiz)
4. **Testnet MON:** deployer + 2 relayer + 1 keeper anahtarı, her biri >10 MON (anahtarları ben üretip adreslerini veririm, sen faucet'ten fonlarsın)
5. *(Opsiyonel)* Özel RPC sağlayıcı anahtarı
