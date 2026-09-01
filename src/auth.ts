import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { secureTokenMatches } from "./security.js";

const identitySchema = z.object({
  controller_cid: z.coerce.number().int().positive(),
  controller_callsign: z.string().trim().min(1).max(32)
});

function tokenMatches(received: string | undefined): boolean {
  if (!received?.startsWith("Bearer ")) return false;
  return secureTokenMatches(received.slice(7), config.PLUGIN_TOKEN);
}

export async function pluginAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!tokenMatches(request.headers.authorization)) {
    return reply.code(401).send({ message: "Invalid or missing plugin token." });
  }

  const source = request.method === "GET" ? request.query : request.body;
  const parsed = identitySchema.safeParse(source);
  if (!parsed.success) {
    return reply.code(401).send({ message: "controller_cid and controller_callsign are required." });
  }

  request.controller = {
    cid: parsed.data.controller_cid,
    callsign: parsed.data.controller_callsign.toUpperCase()
  };
}
