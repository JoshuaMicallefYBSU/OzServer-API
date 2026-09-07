import type { FastifyInstance } from "fastify";
import { SERVERS } from "../auth.js";

// The single source of truth for which servers exist and how to label them, so the website's
// dropdown (and any future consumer) never has to hardcode its own copy that can drift out of
// step with the allowlist in auth.ts - adding a 5th server is then a one-line change here plus a
// one-line change there, never a migration.
const LABELS: Record<string, string> = {
  live: "Live VATSIM",
  sb1: "SweatBox 1",
  sb2: "SweatBox 2",
  newsb: "LocalHost"
};

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.get("/servers", async () => SERVERS.map(value => ({ value, label: LABELS[value] ?? value })));
}
