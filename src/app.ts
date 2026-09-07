import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { config } from "./config.js";
import { pluginAuth } from "./auth.js";
import { pool } from "./db.js";
import { publish } from "./events.js";
import { annotationRoutes } from "./routes/annotations.js";
import { clientLogRoutes } from "./routes/client-logs.js";
import { protectedAtisRoutes, publicAtisRoutes } from "./routes/atis.js";
import { flightRoutes } from "./routes/flights.js";
import { eventRoutes } from "./routes/events.js";
import { mapRoutes } from "./routes/map.js";
import { serverRoutes } from "./routes/servers.js";
import { sectorRoutes } from "./routes/sectors.js";

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: config.WEBSITE_ORIGIN, methods: ["GET"] });
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
      } else if (route.startsWith("/api/v1/annotations")) {
        await publish({ type: "annotations", server });
      }
    });
    await sectorRoutes(pluginApi);
    await flightRoutes(pluginApi);
    await protectedAtisRoutes(pluginApi);
    await annotationRoutes(pluginApi);
    await clientLogRoutes(pluginApi);
  }, { prefix: "/api/v1" });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500)
      .send({ message: error.statusCode && error.statusCode < 500 ? error.message : "Internal server error." });
  });
  return app;
}
