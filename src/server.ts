import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { startEventListener } from "./events.js";
import { runMaintenance } from "./maintenance.js";
import { syncNetworkAtis } from "./network-atis-sync.js";

const app = await buildApp();
// Failing to start the listener must not stop the API booting: without it clients simply fall back
// to their own polling, which is exactly the behaviour that existed before this channel.
await startEventListener(app.log).catch(error => app.log.error(error));
const maintenanceTimer = setInterval(() => void runMaintenance().catch(error => app.log.error(error)), 60_000);
maintenanceTimer.unref();
const syncAtis = () => void syncNetworkAtis().catch(error => app.log.error(error));
syncAtis();
const networkAtisTimer = setInterval(syncAtis, config.NETWORK_ATIS_SYNC_SECONDS * 1000);
networkAtisTimer.unref();
const shutdown = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
await app.listen({ host: config.HOST, port: config.PORT });
