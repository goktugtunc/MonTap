import { cfg, FEEDS } from "./config.js";
import { loadMarketParams } from "./chain.js";
import { migrate } from "./db.js";
import { log } from "./log.js";
import { Oracle } from "./oracle/oracle.js";
import { Indexer } from "./indexer.js";
import { Sender } from "./relayer/sender.js";
import { TapRelayer } from "./relayer/taps.js";
import { Actions } from "./relayer/actions.js";
import { buildApi } from "./api/server.js";

await migrate();
let params = await loadMarketParams(FEEDS.map((f) => f.idx));

const oracle = new Oracle();
oracle.start();

const relayer = new Sender(cfg.RELAYER_PRIVATE_KEYS, "relayer", BigInt(Math.round(cfg.RELAYER_HOURLY_BUDGET_MON * 1e6)) * 10n ** 12n);
const taps = new TapRelayer(params, oracle, relayer);
taps.start();
const actions = new Actions(relayer, taps);

await new Indexer().start();

// zincir parametreleri (çarpan tablosu, limitler) admin tarafından değişebilir → dakikada bir tazele
setInterval(async () => {
  try {
    params = await loadMarketParams(FEEDS.map((f) => f.idx));
    taps.setParams(params);
  } catch (e: any) {
    log.warn({ err: e.message }, "parametre tazeleme hatası");
  }
}, 60_000);

const app = await buildApi({ params: () => params, oracle, taps, actions, relayer });
await app.listen({ host: "0.0.0.0", port: cfg.PORT });
log.info({ oracle: oracle.address, relayers: relayer.addresses }, "MonTap backend hazır");
