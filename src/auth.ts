import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

// The 3 fully isolated vatSys connection targets this API distinguishes between. See
// NetworkServer.cs in the plugin for how a client determines its own value; a new server is a
// one-line change here, not a migration - server is stored as free text (migrations/
// 006_server_isolation.sql), validated only at this application layer. LocalHost is deliberately
// not one of these - OzServer does not operate there at all (NetworkServer.Current is null for
// it), so it never appears as a value a client could send.
export const SERVERS = ["live", "sb1", "sb2"] as const;
export type Server = typeof SERVERS[number];

const identitySchema = z.object({
  controller_cid: z.coerce.number().int().positive(),
  controller_callsign: z.string().trim().min(1).max(32),
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

// For the public (unauthenticated) routes - map.ts, atis.ts's public GET, events.ts - which don't
// go through pluginAuth and validate their own ?server= query param by hand. Matched
// case-sensitively against the lowercase canonical slugs: both producers (the plugin's
// NetworkServer constants, the website's fixed <option value>s) are developer-controlled, not
// user-typed free text, so there is nothing to normalise.
export function parseServer(value: unknown): Server | null {
  return typeof value === "string" && (SERVERS as readonly string[]).includes(value) ? value as Server : null;
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
