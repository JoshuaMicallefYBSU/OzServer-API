import type { Server } from "./auth.js";

export type ControllerIdentity = { cid: number; callsign: string; server: Server };

declare module "fastify" {
  interface FastifyRequest {
    controller: ControllerIdentity;
  }
}
