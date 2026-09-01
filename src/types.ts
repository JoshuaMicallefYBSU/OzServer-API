export type ControllerIdentity = { cid: number; callsign: string };

declare module "fastify" {
  interface FastifyRequest {
    controller: ControllerIdentity;
  }
}
