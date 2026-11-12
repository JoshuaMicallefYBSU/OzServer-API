import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { closeAllClients, startEventListener, stopEventListener } from "./events.js";
import { runMaintenance } from "./maintenance.js";

const app = await buildApp();
// Never rejects and retries on its own for as long as the process lives (see events.ts), so a
// database that is not up yet at boot costs push latency until it is, not the channel itself.
// Without it clients simply fall back to their own polling.
await startEventListener(app.log);
const maintenanceTimer = setInterval(() => void runMaintenance().catch(error => app.log.error(error)), 60_000);
maintenanceTimer.unref();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // If anything below hangs, leave anyway - well inside Docker's ten second stop timeout, so the
  // exit is ours rather than a SIGKILL.
  setTimeout(() => process.exit(0), 8_000).unref();
  clearInterval(maintenanceTimer);
  // Open event streams first: app.close() waits for in-flight responses, and those never end on
  // their own.
  closeAllClients();
  await stopEventListener();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await app.listen({ host: config.HOST, port: config.PORT });
