import type { FastifyInstance } from "fastify";
import { SERVERS } from "../auth.js";

// The labels for the servers in the allowlist in auth.ts, served so the website's dropdown never
// hardcodes its own copy. Adding a server is a one-line change here and one there, not a migration.
const LABELS: Record<string, string> = {
  live: "Live VATSIM",
  sb1: "SweatBox 1",
  sb2: "SweatBox 2"
};

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.get("/servers", async () => SERVERS.map(value => ({ value, label: LABELS[value] ?? value })));
}
