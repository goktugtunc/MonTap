# Demo ve pitch rehberi

## Demo akışı (2–3 dk)

**Hazırlık (sunumdan önce)**
- Sunum tarayıcısında https://monfront.isinigetir.com'u aç, "Hemen oyna"ya bas. Oturum sayfa yenilense de devam eder.
- `https://monback.isinigetir.com/health` → 5 borsa `alive: true`, tick yaşı < 500 ms olmalı.
- Yan panelde "Monad hızı" sekmesi açık kalsın.
- Yedek: ekran kaydı (aşağıdaki "Riskler"e bak).

**Akış**
1. **Sorun (15 sn):** "Perps karmaşık. Mobil kullanıcı 5 saniyelik heyecan istiyor. MegaETH'te Euphoria bu formatı kanıtladı, Monad'da yok."
2. **Onboarding (20 sn):** yeni bir sekmede "Hemen oyna" → faucet, gassız yatırma ve oturum anahtarı ~2 sn'de biter. "Hiç popup görmediniz, hiç gas ödemediniz."
3. **Oyna (60 sn):** fiyatın satırına ve bir üst/alt satıra dokun. Sağ panelde `placeBets×N … 150–350 ms` satırları akar. Birini explorer'da aç.
4. **Kazan (20 sn):** fiyat hücreye girince yeşil patlama ve ses. Panelde `resolve 1W/…` işlemi görünür, ödeme zincirde.
5. **Neden güvenilir (30 sn):** her tap kullanıcı imzalı, kazanma kanıtını herkes sunabilir, fiyat Pyth'e karşı denetleniyor, kasa en kötü senaryoya göre rezerve ediyor.
6. **Yol haritası (15 sn):** 5 dk turlar, tahmin piyasası, copy-trading → "Monad'ın trading + bahis süper uygulaması".

## Pitch'te kullanılacak ölçülmüş rakamlar

| Metrik | Değer | Kaynak |
|---|---|---|
| Zincir onayı | p50 ~330 ms, en iyi 149 ms | `/stats`, canlı |
| Batch | 20 tap → 1 tx, 155 ms | `scripts/load.ts` |
| Onboarding | ~2 sn, 0 popup | e2e + tarayıcı |
| Fiyat | 5 borsa medyanı, 250 ms, imzalı | `/health` |
| Kontrat testleri | 35 birim + invariant (8k rastgele çağrı) | `forge test` |
| Tap maliyeti | ~0.016 MON (batch'te), ~0.04 MON (tek) | ölçüm |

## Jüri soruları — hazır cevaplar

- **"Oracle merkezi değil mi?"** Evet, imzacı bizim; ama her tick zincirde Pyth'e karşı sapma kontrolünden geçiyor, tüm tick'ler imzalı ve herkese açık (denetlenebilir). Pyth'in ms gecikmeli Pro sürümü ücretli; üretimde ona geçiş planlı. Arayüz değişmez, sadece doğrulama fonksiyonu değişir.
- **"Kasa batar mı?"** Bahis anında olası en yüksek ödeme rezerve ediliyor, kapasite %50 ile sınırlı, hücre/pencere limitleri var. Çarpanlar oynaklık aralığına karşı en kötü duruma göre fiyatlanıyor ve gerçek veriyle backtest edildi.
- **"Relayer kapanırsa?"** `placeBetsDirect` ile doğrudan oynanabilir; settlement izinsiz.
- **"Neden Monad?"** 300 ms blok + ucuz gas + EVM. Bu UX başka bir EVM L1'de ya pahalı ya yavaş.

## Riskler ve B planı

- **Public RPC limiti (25–50 rps):** yoğun demoda relayer/indexer yavaşlayabilir. Gerekirse `.env`'de `MONAD_RPC_URL`'i özel bir sağlayıcıyla değiştir.
- **Relayer bütçesi:** saatte 3 MON (spam koruması). Demo öncesi `/health` → `relayerSpentThisHourMon`. Gerekirse `RELAYER_HOURLY_BUDGET_MON` artır.
- **Sakin piyasa:** BTC çok yatay giderse üstteki MON sekmesine geç (daha oynak).
- **Ağ/sahne Wi-Fi'ı:** ekran kaydını önceden al.

## Bakım komutları

```sh
ssh yolal 'cd ~/montap && sudo docker compose logs --tail 50 backend keeper'
ssh yolal 'cd ~/montap && sudo docker compose restart backend keeper'
curl -s https://monback.isinigetir.com/health | jq
```
