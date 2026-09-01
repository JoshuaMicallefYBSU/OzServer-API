import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { config } from "./config.js";
import { pluginAuth } from "./auth.js";
import { pool } from "./db.js";
import { protectedAtisRoutes, publicAtisRoutes } from "./routes/atis.js";
import { flightRoutes } from "./routes/flights.js";
import { mapRoutes } from "./routes/map.js";
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
  }, { prefix: "/api/v1" });
  await app.register(async pluginApi => {
    pluginApi.addHook("preHandler", pluginAuth);
    await sectorRoutes(pluginApi);
    await flightRoutes(pluginApi);
    await protectedAtisRoutes(pluginApi);
  }, { prefix: "/api/v1" });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500)
      .send({ message: error.statusCode && error.statusCode < 500 ? error.message : "Internal server error." });
  });
  return app;
}
