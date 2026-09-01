import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { runMaintenance } from "./maintenance.js";

const app = await buildApp();
const maintenanceTimer = setInterval(() => void runMaintenance().catch(error => app.log.error(error)), 60_000);
maintenanceTimer.unref();
const shutdown = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
await app.listen({ host: config.HOST, port: config.PORT });
