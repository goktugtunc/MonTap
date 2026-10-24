# MonTap — Hackathon Submission

> Every claim below comes from `README.md`, `docs/PLAN.md`, `docs/DEMO.md`, `docs/API.md` or the live `/stats` endpoint (read 24 Oct 2026). MonTap runs on **Monad testnet** with test USDC.

---

## 🇬🇧 ENGLISH

### 1. Project title

**MonTap** — *Tap the chart. Settled onchain in 300 ms.*

Alternative taglines:
- *Five-second trades, one tap, no popups.*
- *Tap-trading on Monad, fully onchain.*
- *Every tap is a Monad transaction.*

### 2. Category

**Primary track: Onchain finance & trading.** MonTap is a short-dated price-prediction market: bets are placed, priced and settled by onchain contracts, and an LP-funded house vault takes the other side.

**Secondary fit: Consumer products & payments.** You start playing in about 2 seconds with zero wallet popups and zero gas, and the game is built mobile-first.

**Tags:** Trading, Consumer, Gaming, Account Abstraction, Oracles, DeFi

### 3. Descriptions

**One-liner (≤140 chars)**
> Tap a cell on a live BTC or MON chart. If price enters that band within 5 seconds, you win. Every tap is a Monad transaction.

**Short description (~50 words)**
> MonTap is tap-trading on Monad. A grid of price bands × 5-second windows sits over a live chart. Tap a cell to place an onchain bet; if price enters the band in that window, you're paid stake × multiplier. Session keys and a relayer remove popups and gas. Taps confirm in ~330 ms.

**Full description**

**The problem.** Mobile users want a result in seconds, and perps are too complex for that. Tap-trading proved the format on MegaETH (Euphoria), but Monad doesn't have it yet. It only works if every tap is final almost instantly and nearly free.

**What MonTap is.** A grid overlays a live chart: rows are price bands ($2 for BTC), columns are 5-second windows, each cell shows a multiplier. A tap is signed by your browser's session key (EIP-712) and sent onchain by the relayer. If any signed tick in that window lands in your band, you get `stake × multiplier`; otherwise the stake goes to the vault.

**Why Monad.** 300 ms blocks, a ~300 ms receipt (`eth_sendRawTransactionSync`), ~600 ms finality, cheap gas (~0.016 MON per batched tap) and full EVM. Elsewhere this UX is slow or expensive.

**Architecture.** A one-time `SessionGrant` lets a browser session key sign taps. A relayer batches up to 500 ms of taps into one `placeBets` transaction. A keeper resolves bets every second, an oracle signs a 5-exchange median every 250 ms, and an ERC-4626-style HouseVault holds LP capital.

**Trust and safety.**
- Settlement is permissionless: a signed tick proves a win, and anyone can submit it.
- Taps are user-signed with a nonce and minimum-multiplier guard; the relayer can't forge them, and `placeBetsDirect` bypasses it.
- The contract rejects ticks more than 1% (BTC) or 2% (MON) away from onchain Pyth.
- The vault reserves each bet's worst-case payout, with cell, window and total caps.
- Multipliers are priced worst-case across a volatility range and backtested on real ticks (EV < 1 in every cell).

The oracle signer is currently ours, so it is centralized. The Pyth deviation check bounds it, and every tick is signed and published for audit.

**Measured results.** 20 taps in 1 transaction in 155 ms. Confirmation p50 ~330 ms (live `/stats`: p50 349 ms, p90 605 ms). Onboarding takes ~2 seconds with 0 popups and 0 gas.

**Roadmap.** Pyth Pro (a millisecond-latency pull oracle), Privy embedded wallets, 5-minute rounds, prediction markets, copy-trading, and a mainnet deploy with the same scripts.

### 4. How it's built / Tech stack

- **Contracts:** Solidity 0.8.31 with Foundry and OpenZeppelin v5.
  - `TapMarket` is the bet engine. It handles EIP-712 sessions and taps, bitmap nonces, millisecond window bounds and the Pyth deviation check.
  - `HouseVault` is an ERC-4626-style LP vault. Shares are priced against worst-case reserves, and withdrawals have a 120 s cooldown.
  - `MockUSDC` is a test USDC with permit, used for gasless deposits.
  - Bets are packed into 2 slots each. Gas: ~385k for a 1-tap batch, ~1.98M for a 20-tap batch (Foundry, Monad pricing).
- **Tests:** 35 unit tests, an invariant test (`totalAssets ≥ reserved`, 8k random calls) and a Monad gas test suite.
- **Backend:** Node 22, TypeScript, Fastify, `ws`, viem, Postgres (`pg`) and Redis. It runs five services:
  - Oracle: median of Binance, Coinbase, OKX, Bybit and Kraken, EIP-712-signed every 250 ms.
  - Relayer: batches taps, sets tight gas limits (`eth_estimateGas` × 1.1) and manages nonces locally.
  - Keeper: resolves bets every second.
  - Indexer: events → Postgres → WebSocket.
  - API: REST + WebSocket.
- **Frontend:** Next.js 15, React 19, plain CSS, zustand. The grid and chart share one Canvas 2D at 60 fps. It uses a burner/browser wallet with a session key and has a live "Monad speed" tx panel.
- **Pricing model:** Monte Carlo (GBM, 250 ms sampling, 5% house edge) across a volatility range, keeping the worst case per cell. A Python backtest runs against real ticks.
- **Infra:** Docker Compose, nginx and Let's Encrypt, with a one-command `deploy.sh`.

### 5. Challenges we ran into

1. **Our oracle plan stopped working.** We planned to use Pyth pull prices through Hermes, but Hermes started requiring a paid API key. Pyth's onchain push feed on testnet only updates about every 7 seconds, which is too slow for 5-second windows. So we built a signed oracle (a 5-exchange median every 250 ms). The contract verifies each tick against onchain Pyth, and all ticks are published so anyone can audit them.
2. **Monad charges for the gas limit, not gas used.** Generous fixed limits or default 30% padding overpay on every tap; our first fixed formula even under-provisioned single-tap batches. We measured real gas with Foundry under Monad pricing, switched to `eth_estimateGas` × 1.1, and batch taps (up to 500 ms or 20 taps). Per-batch overhead is ~300k gas, so a tap costs ~0.04 MON alone but ~0.016 MON in a batch. A `resolve()` function settles all wins and losses in one tx, cutting settlement gas ~50%.
3. **The first multipliers were too generous in calm markets.** The original table assumed one volatility, so when BTC moved sideways the center cells cost the house money. We reprice across a volatility range, take the worst case for each cell, and backtest on real tick paths until every cell has EV < 1.
4. **Public RPC rate limits.** The public RPC allows about 25–50 requests per second. The frontend doesn't read the chain directly: config, balances, sessions and bets all come from our backend API, which serves them from the indexer and Postgres.

### 6. Links

- **Live app:** https://monfront.isinigetir.com
- **API:** https://monback.isinigetir.com (WS: `wss://monback.isinigetir.com/ws`; docs: `docs/API.md`)
- **Live stats:** https://monback.isinigetir.com/stats
- **Network:** Monad testnet (chain ID 10143). The first three contracts below are verified on MonadVision.

| Contract | Address |
|---|---|
| TapMarket | [`0x644cAEb542644E4AE5F277aD61C3C6249288305A`](https://testnet.monadvision.com/address/0x644cAEb542644E4AE5F277aD61C3C6249288305A) |
| HouseVault | [`0x19861DE5204855d80B14336E209B1930AC8a14aE`](https://testnet.monadvision.com/address/0x19861DE5204855d80B14336E209B1930AC8a14aE) |
| MockUSDC (tUSDC) | [`0xBE2f84712EFBcB54DA566AC44e6e6Bd1b42e7b41`](https://testnet.monadvision.com/address/0xBE2f84712EFBcB54DA566AC44e6e6Bd1b42e7b41) |
| Pyth (deviation reference) | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` |

---

## 🇹🇷 TÜRKÇE

### 1. Proje adı

**MonTap** — *Grafiğe dokun. 300 ms'de zincirde kesinleşsin.*

Alternatif sloganlar:
- *Beş saniyelik işlem, tek dokunuş, popup yok.*
- *Monad'da tamamen zincir üstü tap-trading.*
- *Her dokunuş bir Monad işlemi.*

### 2. Kategori

**Ana track: Onchain finance & trading.** MonTap kısa vadeli bir fiyat tahmin piyasası: bahisler zincir üstündeki kontratlarla açılıyor, fiyatlanıyor ve sonuçlanıyor. Karşı tarafta LP'lerin fonladığı bir kasa duruyor.

**İkincil uyum: Consumer products & payments.** Oyuna yaklaşık 2 saniyede, hiç cüzdan popup'ı görmeden ve gas ödemeden başlıyorsun. Arayüz mobil öncelikli.

**Etiketler:** Trading, Consumer, Gaming, Account Abstraction, Oracles, DeFi

### 3. Açıklamalar

**Tek cümle (≤140 karakter)**
> Canlı BTC veya MON grafiğinde bir hücreye dokun. Fiyat 5 saniye içinde o banda girerse kazanırsın. Her dokunuş bir Monad işlemi.

**Kısa açıklama (~50 kelime)**
> MonTap, Monad üzerinde tap-trading. Canlı grafiğin üstünde fiyat bandı × 5 saniyelik pencere hücrelerinden oluşan bir grid var. Bir hücreye dokunmak zincirde bir bahis açar. Fiyat o pencerede banda girerse bahis × çarpan kazanırsın. Session anahtarı ve relayer sayesinde popup ve gas yok. Dokunuşlar ~330 ms'de onaylanıyor.

**Uzun açıklama**

**Sorun.** Perps çoğu mobil kullanıcı için fazla karmaşık. Bu kullanıcılar birkaç saniye içinde karar verip sonucu görmek istiyor. Tap-trading formatı MegaETH'te (Euphoria) kendini kanıtladı ama Monad'da henüz yok. Format ancak her dokunuş neredeyse anında kesinleşirse ve neredeyse bedavaya gelirse çalışıyor.

**MonTap nedir.** Canlı fiyat grafiğinin üstünde bir grid var: satırlar fiyat bantları (BTC için $2), sütunlar 5 saniyelik pencereler, her hücrede bir çarpan yazıyor. Bir hücreye dokunduğunda tarayıcındaki session anahtarı bir EIP-712 `Tap` imzalıyor, relayer da bunu zincire gönderiyor. O penceredeki imzalı tick'lerden biri bandına düşerse `bahis × çarpan` ödeniyor. Düşmezse bahis kasaya geçiyor.

**Neden Monad.** Monad'da bloklar 300 ms. `eth_sendRawTransactionSync` ile makbuz ~300 ms'de geliyor, kesinlik ~600 ms. Gas ucuz (batch'te tap başına ~0.016 MON) ve zincir tamamen EVM uyumlu. Başka EVM L1'lerde bu deneyim ya yavaş ya pahalı.

**Mimari.** Tek seferlik `SessionGrant`, tarayıcıdaki session anahtarının tap imzalamasına izin veriyor. Relayer 500 ms'ye kadar biriken tap'leri tek bir `placeBets` işleminde topluyor. Keeper her saniye kazanç ve kayıpları sonuçlandırıyor. Oracle her 250 ms'de 5 borsanın medyanını imzalıyor. ERC-4626 benzeri HouseVault LP sermayesini tutuyor.

**Güven ve güvenlik.**
- Settlement izinsiz: kazancı imzalı bir tick kanıtlıyor ve bu kanıtı herkes sunabiliyor.
- Tap'ler kullanıcı imzalı, nonce'lu ve en düşük çarpan korumalı, yani relayer tap uyduramaz. `placeBetsDirect` relayer olmadan da çalışıyor.
- Kontrat, zincir üstü Pyth fiyatından BTC'de %1, MON'da %2'den fazla sapan tick'i reddediyor.
- Kasa her bahsin olası en yüksek ödemesini baştan rezerve ediyor. Hücre, pencere ve toplam limitleri de var.
- Çarpanlar bir oynaklık aralığında en kötü duruma göre fiyatlandı ve gerçek tick'lerle backtest edildi: tüm hücrelerde EV < 1.

Oracle imzacısı şu an bizim, yani merkezi. Riski Pyth sapma kontrolü sınırlıyor. Her tick imzalı ve herkese açık yayınlanıyor, böylece herkes denetleyebiliyor.

**Ölçülen sonuçlar.** 20 tap tek işlemde, 155 ms'de onaylandı. Onay p50 ~330 ms (canlı `/stats`: p50 349 ms, p90 605 ms). Onboarding ~2 saniye sürüyor: 0 popup, 0 gas.

**Yol haritası.** Pyth Pro (ms gecikmeli pull oracle), Privy gömülü cüzdan, 5 dakikalık turlar, tahmin piyasaları, copy-trading ve aynı script'lerle mainnet deploy.

### 4. Nasıl yapıldı / Teknoloji yığını

- **Kontratlar:** Solidity 0.8.31, Foundry ve OpenZeppelin v5.
  - `TapMarket` bahis motoru. EIP-712 oturum ve tap'leri, bitmap nonce'ları, ms hassasiyetli pencere sınırlarını ve Pyth sapma kontrolünü yönetiyor.
  - `HouseVault` ERC-4626 benzeri LP kasası. Paylar en kötü senaryo rezervine göre fiyatlanıyor, çekimlerde 120 sn bekleme süresi var.
  - `MockUSDC`, gassız yatırma için permit destekli test USDC.
  - Bahisler 2 slota paketleniyor. Gas: 1 tap'lik batch ~385k, 20 tap'lik batch ~1.98M (Foundry, Monad fiyatlaması).
- **Testler:** 35 birim testi, invariant testi (`totalAssets ≥ reserved`, 8k rastgele çağrı) ve Monad gas test seti.
- **Backend:** Node 22, TypeScript, Fastify, `ws`, viem, Postgres (`pg`) ve Redis. Beş servis çalışıyor:
  - Oracle: Binance, Coinbase, OKX, Bybit ve Kraken medyanı, 250 ms'de bir EIP-712 ile imzalı.
  - Relayer: tap'leri topluyor, sıkı gas limiti veriyor (`eth_estimateGas` × 1,1) ve nonce'ları lokal yönetiyor.
  - Keeper: bahisleri her saniye sonuçlandırıyor.
  - Indexer: event'ler → Postgres → WebSocket.
  - API: REST + WebSocket.
- **Frontend:** Next.js 15, React 19, düz CSS, zustand. Grid ve grafik tek bir Canvas 2D'de, 60 fps. Session anahtarlı burner/tarayıcı cüzdanı ve canlı "Monad hızı" işlem paneli var.
- **Fiyatlama modeli:** Bir oynaklık aralığında Monte Carlo (GBM, 250 ms örnekleme, %5 kasa payı), her hücre için en kötü durum alınıyor. Gerçek tick'lere karşı Python backtest'i çalışıyor.
- **Altyapı:** Docker Compose, nginx ve Let's Encrypt, tek komutluk `deploy.sh`.

### 5. Karşılaştığımız zorluklar

1. **Oracle planımız çalışmaz hale geldi.** Pyth pull fiyatlarını Hermes üzerinden kullanacaktık ama Hermes ücretli API anahtarı istemeye başladı. Testnet'teki zincir üstü Pyth push akışı da ~7 saniyede bir güncelleniyor, bu 5 saniyelik pencereler için çok yavaş. Bu yüzden imzalı bir oracle yazdık (250 ms'de bir 5 borsa medyanı). Kontrat her tick'i zincir üstü Pyth'e karşı doğruluyor ve tüm tick'ler herkesin denetleyebilmesi için yayınlanıyor.
2. **Monad, harcanan gas'ı değil gas limitini ücretlendiriyor.** Cömert sabit limitler ya da varsayılan %30 pay her tap'te fazla ödetir; ilk sabit formülümüz ise tek tap'lik batch'lerde limiti yetersiz bırakıyordu. Gerçek gas'ı Monad fiyatlamasıyla Foundry'de ölçtük, `eth_estimateGas` × 1,1'e geçtik ve tap'leri topladık (500 ms'ye ya da 20 tap'e kadar). Batch başına ~300k sabit maliyet olduğu için tap tek başına ~0.04 MON, batch'te ~0.016 MON. `resolve()` tüm kazanç ve kayıpları tek işlemde kapatıyor, settlement gas'ı ~%50 düştü.
3. **İlk çarpanlar sakin piyasada fazla cömertti.** İlk tablo tek bir oynaklık varsayıyordu, BTC yatay gidince merkez hücreler kasaya zarar ettirdi. Şimdi çarpanları bir oynaklık aralığında yeniden fiyatlıyoruz, her hücre için en kötü durumu alıyoruz ve tüm hücrelerde EV < 1 çıkana kadar gerçek tick yollarında backtest ediyoruz.
4. **Public RPC limitleri.** Public RPC saniyede yaklaşık 25–50 istek kabul ediyor. Frontend zinciri doğrudan okumuyor: config, bakiyeler, oturumlar ve bahisler backend API'den geliyor, o da bunları indexer ve Postgres'ten sunuyor.

### 6. Linkler

- **Canlı uygulama:** https://monfront.isinigetir.com
- **API:** https://monback.isinigetir.com (WS: `wss://monback.isinigetir.com/ws`; dokümantasyon: `docs/API.md`)
- **Canlı istatistikler:** https://monback.isinigetir.com/stats
- **Ağ:** Monad testnet (chain ID 10143). Aşağıdaki ilk üç kontrat MonadVision'da doğrulanmış.

| Kontrat | Adres |
|---|---|
| TapMarket | [`0x644cAEb542644E4AE5F277aD61C3C6249288305A`](https://testnet.monadvision.com/address/0x644cAEb542644E4AE5F277aD61C3C6249288305A) |
| HouseVault | [`0x19861DE5204855d80B14336E209B1930AC8a14aE`](https://testnet.monadvision.com/address/0x19861DE5204855d80B14336E209B1930AC8a14aE) |
| MockUSDC (tUSDC) | [`0xBE2f84712EFBcB54DA566AC44e6e6Bd1b42e7b41`](https://testnet.monadvision.com/address/0xBE2f84712EFBcB54DA566AC44e6e6Bd1b42e7b41) |
| Pyth (sapma referansı) | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` |
