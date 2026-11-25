import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { config } from "./config.js";
import { reportServerError } from "./alerts.js";
import { pluginAuth } from "./auth.js";
import { pool } from "./db.js";
import { publish } from "./events.js";
import { invalidateExternalHoldings } from "./external-control.js";
import { notePluginRequest } from "./presence.js";
import { arrivalRoutes } from "./routes/arrivals.js";
import { protectedClientLogRoutes, publicClientLogRoutes } from "./routes/client-logs.js";
import { protectedAtisRoutes, publicAtisRoutes } from "./routes/atis.js";
import { flightRoutes } from "./routes/flights.js";
import { eventRoutes } from "./routes/events.js";
import { mapRoutes } from "./routes/map.js";
import { networkRoutes } from "./routes/network.js";
import { adminMessageRoutes, protectedMessageRoutes } from "./routes/messages.js";
import { pluginRoutes } from "./routes/plugin.js";
import { serverRoutes } from "./routes/servers.js";
import { sectorRoutes } from "./routes/sectors.js";

// When each plugin client's presence was last written - see the heartbeat hook below.
const PLUGIN_CLIENT_REFRESH_MS = 2000;
const pluginClientSeen = new Map<string, number>();
// A client not heard from for this long has dropped off the list of plugin users
// (PLUGIN_CLIENT_WINDOW_SECONDS in external-control.ts), so its next call puts it back on.
const PLUGIN_CLIENT_RETURN_MS = 15_000;

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  // Before any route or plugin is registered: Fastify gives a route the error handler in force when
  // the route is added. Set after them, as this was, it applied to none - a fault was answered with
  // the database's own message, and never reached reportServerError.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    app.log.error(error);
    // A fault of ours rather than a bad request: worth someone seeing as it happens.
    if (!error.statusCode || error.statusCode >= 500) {
      reportServerError(`${request.method} ${request.routeOptions?.url ?? request.url.split("?")[0]}`, error);
    }
    reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500)
      .send({ message: error.statusCode && error.statusCode < 500 ? error.message : "Internal server error." });
  });
  await app.register(cors, { origin: config.WEBSITE_ORIGIN, methods: ["GET"] });

  // A fixed ten second window per address, held in memory. No caller is authenticated, so this is
  // all that stops one client filling client_logs, keeping the sector lock busy or crowding every
  // controller's poll out of the connection pool. Generous by design (see RATE_LIMIT_PER_10S): a
  // controller wrongly turned away stops heartbeating, which costs more than letting an abuser
  // through. Per process, which suits the single container this runs as; behind Caddy on the same
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
    await pluginRoutes(publicApi);
    await publicClientLogRoutes(publicApi);
    // Token-gated (CONSOLE_TOKEN), not plugin-authenticated: called by the website's server for the
    // /console, which has no controller identity.
    await adminMessageRoutes(publicApi);
  }, { prefix: "/api/v1" });
  await app.register(async pluginApi => {
    pluginApi.addHook("preHandler", pluginAuth);
    // The presence heartbeat: every authenticated call refreshes last_seen_online_at on the
    // caller's ownership rows, which is what the disconnect sweep (maintenance.ts) and claimGroup's
    // presence check age a row against. A preHandler so a route's early return cannot skip it; it
    // matches no rows for a controller who owns nothing.
    pluginApi.addHook("preHandler", async request => {
      // Before the heartbeat is judged by anything: a call arriving after a long silence from every
      // plugin means this server was out of reach, not that they all left (presence.ts).
      notePluginRequest();
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
      const lastSeen = pluginClientSeen.get(key) ?? 0;
      if (lastSeen > now - PLUGIN_CLIENT_REFRESH_MS) return;
      if (pluginClientSeen.size > 10000) pluginClientSeen.clear();
      pluginClientSeen.set(key, now);
      try {
        await pool.query(
          `INSERT INTO plugin_clients (controller_cid,controller_callsign,server,last_seen_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (server,controller_callsign,controller_cid) DO UPDATE SET last_seen_at=now()`,
          [request.controller.cid, request.controller.callsign, request.controller.server]);
        // A plugin that has just started changes what counts as held without it: its controller
        // stops being one of those controllers, and the sector they are logged on as stops being
        // held against them (external-control.ts). The holdings are cached for a couple of seconds,
        // and this controller's first claim, of that very sector, arrives sooner than that - it
        // was refused as somebody else's. Done before the route runs, so it sees the new answer.
        if (lastSeen < now - PLUGIN_CLIENT_RETURN_MS) invalidateExternalHoldings(request.controller.server);
      } catch (error) {
        pluginClientSeen.delete(key);
        app.log.warn(error, "Could not record plugin client presence.");
      }
    });
    // One hook rather than a publish() call in every handler: the route path already says which
    // group changed, and a hook cannot be forgotten when a mutation route is added. onResponse (not
    // onSend) so nothing is announced before its transaction has committed.
    pluginApi.addHook("onResponse", async (request, reply) => {
      if (request.method !== "POST" || reply.statusCode >= 400) return;
      const route = request.routeOptions?.url ?? request.url;
      const server = request.controller.server;
      if (route.startsWith("/api/v1/sectors") || route.startsWith("/api/v1/sector-requests")) {
        // One signal for both: /sectors/sync returns owned, controlled and requests together, so a
        // subscriber answers either with the same call.
        // Ownership just changed, and with it what is left for a controller without the plugin to
        // be holding: the syncs this signal prompts must not be answered from before it.
        invalidateExternalHoldings(server);
        await publish({ type: "sectors", server });
      } else if (route.startsWith("/api/v1/fdr")) {
        await publish({ type: "fdr", server });
      } else if (route.startsWith("/api/v1/atis")) {
        await publish({ type: "atis", server });
      } else if (route.startsWith("/api/v1/client-logs")) {
        // Deliberately silent: nothing subscribes to these, and every controller posts them
        // continuously.
        return;
      }
    });
    await sectorRoutes(pluginApi);
    await flightRoutes(pluginApi);
    await arrivalRoutes(pluginApi);
    await networkRoutes(pluginApi);
    await protectedAtisRoutes(pluginApi);
    await protectedClientLogRoutes(pluginApi);
    await protectedMessageRoutes(pluginApi);
  }, { prefix: "/api/v1" });
  return app;
}
