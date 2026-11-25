import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

// The isolated vatSys connection targets this API distinguishes between; NetworkServer.cs in the
// plugin determines a client's own value. Stored as free text (migrations/006_server_isolation.sql)
// and validated only here, so adding a server is a change to this list (and its label in
// routes/servers.ts), not a migration. LocalHost is deliberately absent: the plugin does not
// operate there.
export const SERVERS = ["live", "sb1", "sb2"] as const;
export type Server = typeof SERVERS[number];

const identitySchema = z.object({
  // Bounded by the integer columns it is stored in, and free of the one character Postgres text
  // cannot hold: past either, every query naming this controller failed, answered as a fault of
  // the server's rather than as the bad request it is.
  controller_cid: z.coerce.number().int().positive().max(2_147_483_647),
  controller_callsign: z.string().trim().min(1).max(32).refine(value => !value.includes("\u0000")),
  server: z.enum(SERVERS)
});

export function parseControllerIdentity(source: unknown): { cid: number; callsign: string; server: Server } | null {
  const parsed = identitySchema.safeParse(source);
  if (!parsed.success) return null;
  return {
    cid: parsed.data.controller_cid,
    callsign: parsed.data.controller_callsign.toUpperCase(),
    server: parsed.data.server
  };
}

// For the public routes, which do not go through pluginAuth and validate their own ?server= query
// parameter. Matched case-sensitively against the lowercase slugs: both producers (the plugin's
// NetworkServer constants and the website's fixed option values) are developer-controlled, so
// there is nothing to normalise.
export function parseServer(value: unknown): Server | null {
  return typeof value === "string" && (SERVERS as readonly string[]).includes(value) ? value as Server : null;
}

// For the shared-secret gates (CLIENT_LOGS_TOKEN, ATIS_TOKEN). Compared in constant time so a
// token cannot be recovered character by character from response timing.
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function pluginAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const source = request.method === "GET" ? request.query : request.body;
  const identity = parseControllerIdentity(source);
  if (identity === null) {
    return reply.code(401).send({
      message: "controller_cid, controller_callsign and a valid server are required. If you are "
        + "seeing this after an update, your OzServer plugin build is out of date - please update it."
    });
  }

  request.controller = identity;
}
