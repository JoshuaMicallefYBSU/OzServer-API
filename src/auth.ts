import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { onlineControllers } from "./vatsim.js";

const identitySchema = z.object({
  controller_cid: z.coerce.number().int().positive(),
  controller_callsign: z.string().trim().min(1).max(32)
});

export function controllerIsOnline(online: Map<string, number>, cid: number, callsign: string): boolean {
  return online.get(callsign.toUpperCase()) === cid;
}

export async function pluginAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const source = request.method === "GET" ? request.query : request.body;
  const parsed = identitySchema.safeParse(source);
  if (!parsed.success) {
    return reply.code(401).send({ message: "controller_cid and controller_callsign are required." });
  }

  const callsign = parsed.data.controller_callsign.toUpperCase();
  const online = await onlineControllers();
  if (online === null) {
    return reply.code(503).send({ message: "VATSIM controller verification is temporarily unavailable." });
  }
  if (!controllerIsOnline(online, parsed.data.controller_cid, callsign)) {
    return reply.code(401).send({ message: "Controller CID and callsign are not currently online on VATSIM." });
  }

  request.controller = {
    cid: parsed.data.controller_cid,
    callsign
  };
}
