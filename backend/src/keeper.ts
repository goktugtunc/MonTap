import { cfg, FEEDS } from "./config.js";
import { loadMarketParams } from "./chain.js";
import { migrate } from "./db.js";
import { log } from "./log.js";
import { Keeper } from "./keeper/keeper.js";
import { Sender } from "./relayer/sender.js";

if (!cfg.KEEPER_PRIVATE_KEY) throw new Error("KEEPER_PRIVATE_KEY gerekli");
await migrate();
const params = await loadMarketParams(FEEDS.map((f) => f.idx));
const sender = new Sender([cfg.KEEPER_PRIVATE_KEY], "keeper");
await new Keeper(params, sender).start();
log.info({ keeper: sender.addresses[0] }, "keeper hazır");
