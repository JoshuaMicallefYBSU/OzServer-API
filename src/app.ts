import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { config } from "./config.js";
import { pluginAuth } from "./auth.js";
import { pool } from "./db.js";
import { publish } from "./events.js";
import { protectedClientLogRoutes, publicClientLogRoutes } from "./routes/client-logs.js";
import { protectedAtisRoutes, publicAtisRoutes } from "./routes/atis.js";
import { flightRoutes } from "./routes/flights.js";
import { eventRoutes } from "./routes/events.js";
import { mapRoutes } from "./routes/map.js";
import { serverRoutes } from "./routes/servers.js";
import { sectorRoutes } from "./routes/sectors.js";

// When each plugin client's presence was last written - see the heartbeat hook below.
const PLUGIN_CLIENT_REFRESH_MS = 2000;
const pluginClientSeen = new Map<string, number>();

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: config.WEBSITE_ORIGIN, methods: ["GET"] });

  // A fixed ten second window per address, held in memory. Nothing here authenticates a caller, so
  // this is the only thing between a script in a loop and the database: without it one client could
  // fill client_logs, hold the sector lock busy, or simply crowd every controller's poll out of the
  // connection pool. Deliberately generous (see RATE_LIMIT_PER_10S) - a controller wrongly turned
  // away stops heartbeating, which costs them far more than an abuser being let through costs us.
  // Per process, which is right for the single container this runs as; behind Caddy on the same
  // host, request.ip is the real client address (trustProxy above).
  const RATE_WINDOW_MS = 10_000;
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweepHits = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }, 60_000);
  sweepHits.unref();
  app.addHook("onClose", async () => clearInterval(sweepHits));
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    const now = Date.now();
    let entry = hits.get(request.ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
      hits.set(request.ip, entry);
    }
    if (++entry.count > config.RATE_LIMIT_PER_10S) {
      return reply.code(429)
        .header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)))
        .send({ message: "Too many requests - slow down." });
    }
  });
  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok", database: "ok" };
    } catch {
      return reply.code(503).send({ status: "unhealthy", database: "unavailable" });
    }
  });
  await app.register(async publicApi => {
    await publicAtisRoutes(publicApi);
    await mapRoutes(publicApi);
    await eventRoutes(publicApi);
    await serverRoutes(publicApi);
    await publicClientLogRoutes(publicApi);
  }, { prefix: "/api/v1" });
  await app.register(async pluginApi => {
    pluginApi.addHook("preHandler", pluginAuth);
    // Refreshes this controller's own presence on every authenticated call, not only the ones that
    // touch sector_ownerships directly. This is what runMaintenance's disconnect sweep now ages a
    // row against instead of VATSIM's public datafeed (see its own comment for why) - every
    // connected client already calls this API every few seconds on its own polling regardless of
    // what it's actually doing, which is a faster, purely internal presence signal than a
    // third-party feed with its own separate publish lag in both directions. Runs before the route
    // itself so it cannot be skipped by an early return, and is a no-op (0 rows matched) for a
    // controller who owns nothing yet, so it's safe unconditionally.
    pluginApi.addHook("preHandler", async request => {
      try {
        await pool.query(
          "UPDATE sector_ownerships SET last_seen_online_at=now() WHERE controller_cid=$1 AND controller_callsign=$2 AND server=$3",
          [request.controller.cid, request.controller.callsign, request.controller.server]);
      } catch (error) {
        app.log.warn(error, "Could not refresh controller heartbeat.");
      }
      // And that this controller runs the plugin at all, sectors or not - see
      // migrations/012_plugin_clients.sql. At most every few seconds per client: each one calls
      // several times a second, and the list it feeds is only read against a timeout.
      const key = `${request.controller.server}|${request.controller.callsign}|${request.controller.cid}`;
      const now = Date.now();
      if ((pluginClientSeen.get(key) ?? 0) > now - PLUGIN_CLIENT_REFRESH_MS) return;
      if (pluginClientSeen.size > 10000) pluginClientSeen.clear();
      pluginClientSeen.set(key, now);
      try {
        await pool.query(
          `INSERT INTO plugin_clients (controller_cid,controller_callsign,server,last_seen_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (server,controller_callsign,controller_cid) DO UPDATE SET last_seen_at=now()`,
          [request.controller.cid, request.controller.callsign, request.controller.server]);
      } catch (error) {
        pluginClientSeen.delete(key);
        app.log.warn(error, "Could not record plugin client presence.");
      }
    });
    // One hook rather than a publish() call inside every handler. What a subscriber needs to know
    // is "something under this route group changed", which the route path already says, and a hook
    // cannot be forgotten the way a per-handler call can when a mutation route is added later.
    // onResponse (not onSend) so nothing is announced before its transaction has committed.
    pluginApi.addHook("onResponse", async (request, reply) => {
      if (request.method !== "POST" || reply.statusCode >= 400) return;
      const route = request.routeOptions?.url ?? request.url;
      const server = request.controller.server;
      if (route.startsWith("/api/v1/sectors") || route.startsWith("/api/v1/sector-requests")) {
        // Deliberately one signal for both: /sectors/sync already returns owned, controlled and
        // requests together, so a subscriber answers either with the same single call.
        await publish({ type: "sectors", server });
      } else if (route.startsWith("/api/v1/fdr")) {
        await publish({ type: "fdr", server });
      } else if (route.startsWith("/api/v1/atis")) {
        await publish({ type: "atis", server });
      } else if (route.startsWith("/api/v1/client-logs")) {
        // Deliberately silent: nothing subscribes to these, and every controller posts
        // them continuously - announcing each batch would wake every client for nothing.
        return;
      }
    });
    await sectorRoutes(pluginApi);
    await flightRoutes(pluginApi);
    await protectedAtisRoutes(pluginApi);
    await protectedClientLogRoutes(pluginApi);
  }, { prefix: "/api/v1" });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500)
      .send({ message: error.statusCode && error.statusCode < 500 ? error.message : "Internal server error." });
  });
  return app;
}
