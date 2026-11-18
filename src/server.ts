import { discord, reportServerError } from "./alerts.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { closeAllClients, startEventListener, stopEventListener } from "./events.js";
import { startLiveStats } from "./live-stats.js";
import { runMaintenance } from "./maintenance.js";

const app = await buildApp();
// Never rejects, and retries for as long as the process lives (see events.ts): a database that is
// not up at boot delays push events rather than disabling them. Clients poll in the meantime.
await startEventListener(app.log);
const maintenanceTimer = setInterval(() => void runMaintenance().catch(error => {
  app.log.error(error);
  reportServerError("maintenance sweep", error);
}), 60_000);
maintenanceTimer.unref();
discord.start();
// Edits the live network stats into their Discord channel - a no-op unless DISCORD_LIVE_WEBHOOK_URL
// is set.
const liveStatsTimer = startLiveStats(app.log);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // If anything below hangs, leave anyway - well inside Docker's ten second stop timeout, so the
  // exit is ours rather than a SIGKILL.
  setTimeout(() => process.exit(0), 8_000).unref();
  clearInterval(maintenanceTimer);
  if (liveStatsTimer) clearInterval(liveStatsTimer);
  // Open event streams first: app.close() waits for in-flight responses, and those never end on
  // their own.
  closeAllClients();
  await stopEventListener();
  await app.close();
  // Whatever is still queued for Discord goes out before the process does.
  await discord.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await app.listen({ host: config.HOST, port: config.PORT });
