import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reportClientLog } from "../alerts.js";
import { parseServer, tokenMatches } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";

// Collects every controller's plugin log so two clients can be compared side by side - see
// migrations/004_client_logs.sql for why, and migrations/006_server_isolation.sql for `server`.

// Batched by the client, so the cap is per request rather than per line. Generous enough that a
// reconnect burst arrives in one call, bounded so a looping client cannot post unbounded volume.
const MaxLinesPerBatch = 200;

// How far a line's own timestamp may sit from the server's clock before it is replaced with the
// server's. The client clock is used for ordering only, and a little disagreement between two
// clients is worth seeing - but a clock that is days out (or an absurd `at`) would file the line
// outside every window anyone queries.
const MaxClockSkewMs = 12 * 60 * 60 * 1000;

// "30 minutes", "2 hours", "1 day". Passed to Postgres as an interval, and validated first:
// Postgres accepts far more than this ("100 years" is a scan of the whole table) and answers
// anything it rejects with an error.
const sinceSchema = z.string().trim().regex(/^\d{1,4}\s*(second|minute|hour|day)s?$/i).default("30 minutes");
const limitSchema = z.coerce.number().int().min(1).max(5000).default(500);

const batchSchema = z.object({
  lines: z.array(z.object({
    // Client clock. Used for ordering only, never to decide anything (see MaxClockSkewMs).
    at: z.coerce.date(),
    category: z.string().trim().min(1).max(32),
    message: z.string().trim().min(1).max(2000),
    plugin_version: z.string().trim().max(64).optional(),
    session_id: z.string().trim().max(64).optional(),
    sequence: z.number().int().nonnegative().optional(),
    context: z.record(z.string(), z.unknown()).optional()
  })).min(1).max(MaxLinesPerBatch)
});

// The ingestion path - under pluginAuth like every other write.
export async function protectedClientLogRoutes(app: FastifyInstance): Promise<void> {
  app.post("/client-logs", async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ message: "Invalid log batch.", errors: parsed.error.flatten() });
    }

    const { lines } = parsed.data;

    // One statement for the whole batch: a row per INSERT would make a reconnect burst dozens of
    // round trips. `server`, like controller_cid and controller_callsign, is one value for the
    // whole request - a client session is on one server at a time.
    await pool.query(
      `INSERT INTO client_logs
         (controller_cid,controller_callsign,server,category,message,logged_at,plugin_version,session_id,sequence,context)
       SELECT $1,$2,$3,* FROM unnest($4::text[],$5::text[],$6::timestamptz[],$7::text[],$8::text[],$9::bigint[],$10::jsonb[])`,
      [request.controller.cid, request.controller.callsign, request.controller.server,
       lines.map(line => line.category),
       lines.map(line => line.message),
       lines.map(line => Math.abs(line.at.getTime() - Date.now()) > MaxClockSkewMs ? new Date() : line.at),
       lines.map(line => line.plugin_version ?? null),
       lines.map(line => line.session_id ?? null),
       lines.map(line => line.sequence ?? null),
       lines.map(line => line.context == null ? null : JSON.stringify(line.context))]);

    // After the insert, so a line relayed to Discord is always one that can be looked up here.
    for (const line of lines) reportClientLog(request.controller, line);

    return reply.code(204).send();
  });
}

// The read side - a diagnostics tool driven by a person (by hand for an investigation, and by
// /console for a live tail), not an operation a controller identity stands behind. Deliberately
// outside pluginAuth, which demands a controller identity and a server and so would make the
// optional `server` filter below impossible to omit. CLIENT_LOGS_TOKEN gates it when set.
export async function publicClientLogRoutes(app: FastifyInstance): Promise<void> {
  // Ordered oldest-first because these are read as a narrative, and limited to a recent window by
  // default - the usual question is "what were all of them doing when this happened".
  //
  // `server` is optional here, unlike everywhere else in this API: an investigation can span
  // servers (a controller reproducing on a SweatBox, then again on live). It is included in the
  // response so a row stays self-describing when the filter is left off.
  app.get<{ Querystring: {
    since?: string; callsign?: string; category?: string; limit?: string;
    sector?: string; fdr_callsign?: string; request_id?: string; session_id?: string; server?: string;
    token?: string;
  } }>(
    "/client-logs", async (request, reply) => {
      // Optional gate - see CLIENT_LOGS_TOKEN. Everything this returns names a controller.
      if (config.CLIENT_LOGS_TOKEN) {
        const header = request.headers.authorization;
        const presented = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : request.query.token;
        if (!tokenMatches(presented, config.CLIENT_LOGS_TOKEN)) {
          return reply.code(401).send({ message: "A valid token is required to read client logs." });
        }
      }

      const parsedSince = sinceSchema.safeParse(request.query.since);
      const parsedLimit = limitSchema.safeParse(request.query.limit);
      if (!parsedSince.success || !parsedLimit.success) {
        return reply.code(400).send({
          message: "since must look like '30 minutes' (seconds, minutes, hours or days) and limit must be 1-5000."
        });
      }
      const since = parsedSince.data;
      const limit = parsedLimit.data;
      const server = request.query.server === undefined ? null : parseServer(request.query.server);
      if (request.query.server !== undefined && server === null) {
        return reply.code(400).send({ message: "server, if given, must be one of the known servers." });
      }

      const rows = await pool.query(
        `SELECT controller_cid,controller_callsign,server,category,message,logged_at,created_at,
                plugin_version,session_id,sequence,context
           FROM client_logs
          WHERE logged_at >= now()-$1::interval
            AND ($2::text IS NULL OR controller_callsign = $2)
            AND ($3::text IS NULL OR category = $3)
            AND ($4::text IS NULL OR session_id = $4)
            AND ($5::text IS NULL OR context->>'sector' = $5 OR context->'sectors' ? $5
                 OR context->'claimed' ? $5 OR context->'released' ? $5 OR context->'requested' ? $5
                 OR context->'skipped' ? $5 OR context->'withheld' ? $5 OR context->'transferred' ? $5)
            AND ($6::text IS NULL OR context->>'fdr_callsign' = $6 OR context->>'callsign' = $6)
            AND ($7::text IS NULL OR context->>'request_id' = $7 OR context->'request_ids' ? $7)
            AND ($9::text IS NULL OR server = $9)
          ORDER BY logged_at, created_at, id
          LIMIT $8`,
        [since, request.query.callsign ?? null, request.query.category ?? null,
         request.query.session_id ?? null, request.query.sector ?? null,
         request.query.fdr_callsign ?? null, request.query.request_id ?? null, limit, server]);

      return rows.rows;
    });
}
