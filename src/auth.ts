import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const identitySchema = z.object({
  controller_cid: z.coerce.number().int().positive(),
  controller_callsign: z.string().trim().min(1).max(32)
});

export function parseControllerIdentity(source: unknown): { cid: number; callsign: string } | null {
  const parsed = identitySchema.safeParse(source);
  if (!parsed.success) return null;
  return {
    cid: parsed.data.controller_cid,
    callsign: parsed.data.controller_callsign.toUpperCase()
  };
}

export async function pluginAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const source = request.method === "GET" ? request.query : request.body;
  const identity = parseControllerIdentity(source);
  if (identity === null) {
    return reply.code(401).send({ message: "controller_cid and controller_callsign are required." });
  }

  request.controller = identity;
}
