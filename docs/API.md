# MonTap Backend API

Base: `https://monback.isinigetir.com` · WS: `wss://monback.isinigetir.com/ws`

Tüm tutarlar string (bigint). tUSDC 6 ondalıklı, fiyatlar expo −8 (`8065000000000` = $80,650).

## EIP-712

Domain (TapMarket): `{ name: "MonTap", version: "1", chainId, verifyingContract: contracts.market }`

| Tip | Alanlar | Kim imzalar |
|---|---|---|
| `SessionGrant` | `user address, sessionKey address, spendLimit uint96, expiry uint64, nonce uint256` | Kullanıcının ana cüzdanı (Privy), bir kez. `nonce = sessionNonce(user)` |
| `Tap` | `user address, feedIdx uint8, bandIdx int64, windowIdx uint64, stake uint96, minMultBps uint32, nonce uint256, deadline uint64` | Tarayıcıdaki session anahtarı, her dokunuşta |
| `Withdraw` | `user address, to address, amount uint256, nonce uint256, deadline uint64` | Ana cüzdan. `nonce = withdrawNonce(user)` |
| `PriceTick` | `feedIdx uint8, price int64, timestampMs uint64` | Oracle (backend) |

Permit (tUSDC): domain `{ name: "MonTap Test USDC", version: "1", chainId, verifyingContract: contracts.usdc }`, standart EIP-2612, `spender = contracts.market`.

Tap nonce'ları bitmap: sıralı olmak zorunda değil, her biri bir kez. Önerilen: `Date.now()` tabanlı ya da sayaç.

## Grid matematiği (frontend tarafında)

```
bandSize = feeds[i].bandSize          // BTC: 1e9 ($10), MON: 1000 ($0.00001)
band     = floor(price / bandSize)    // [band·size, (band+1)·size)
window   = floor(unixSec / windowLen) // [w·5, (w+1)·5) sn
dist     = |band − currentBand|        // 0..15
col      = window − currentWindow      // 0..11; pencere başı ≥ now + minLead + 1.5 olmalı
mult     = feeds[i].multipliers[dist][col] / 10000   // 0 → hücre kapalı
```

Kazanma: pencere içindeki (ms) herhangi bir imzalı tick'in fiyatı bantta. Frontend tick akışından kazancı **anında** görebilir; zincirdeki settle ~1–2 sn sonra gelir.

## REST

| Method | Yol | Gövde / Yanıt |
|---|---|---|
| GET | `/health` | oracle kaynakları, tick yaşları, relayer harcaması |
| GET | `/config` | chainId, rpcUrl, explorer, contracts, oracle, windowLen, minLead, grace, minStake, maxStake, feeds[] (bandSize, multipliers 16×12) |
| GET | `/ticks/:feed?limit=600` | son imzalı tick'ler (yeni → eski), grafik başlangıcı |
| GET | `/me/:addr` | balance (oyun bakiyesi), wallet (tUSDC), session, stats, son 50 bahis |
| GET | `/bets/recent` | son 50 bahis (global akış) |
| GET | `/leaderboard` | 24 saatlik PnL |
| GET | `/stats` | toplam bahis/hacim/oyuncu, tx gecikmesi p50/p90 |
| POST | `/faucet` | `{ user }` → 100 tUSDC cüzdana (10 dk cooldown) |
| POST | `/deposit` | `{ user, amount, deadline, v, r, s }` (permit) → oyun bakiyesine |
| POST | `/session` | `{ user, sessionKey, spendLimit, expiry, sig }` |
| POST | `/tap` | `{ tap: {user, feedIdx, bandIdx, windowIdx, stake, minMultBps, nonce, deadline}, sig }` → `{status:"placed", betId, multBps, tx, latencyMs, block}` ya da `{status:"rejected", reason}` |
| POST | `/withdraw` | `{ user, to, amount, deadline, sig }` |

Red sebepleri: `Feed, Deadline, Session, SpendLimit, BadSig, Nonce, Stake, Balance, Window, Mult, Payout, CellCap, WindowCap, Capacity, RelayerBudget, RelayerError`.

Limitler: `/tap` kullanıcı başına 60/dk; sponsorlu uçlar IP başına 6/dk; relayer saatte en fazla 3 MON harcar (aşılırsa 503).

## WebSocket

```json
→ {"op":"sub","ch":["tick:0","tick:1","txs","chain:events","user:0xabc…"]}
← {"ch":"tick:0","data":{"feedIdx":0,"price":"8065…","timestampMs":…,"sig":"0x…","sources":5}}
← {"ch":"txs","data":{"label":"placeBets×6","hash":"0x…","block":"…","latencyMs":313,…}}
← {"ch":"user:0xabc…","data":{"type":"tap","nonce":"1","status":"placed","betId":"7",…}}
← {"ch":"user:0xabc…","data":{"type":"BetWon","betId":"7","payout":"1778300",…}}
```

`tick:N` 250 ms'de bir; her tick imzalı (herkes doğrulayabilir → oracle denetlenebilir).
