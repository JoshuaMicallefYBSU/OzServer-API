import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";

// Collects every controller's plugin log so two clients can be compared side by side - see
// migrations/004_client_logs.sql for why.

// Batched by the client, so the cap is per request rather than per line. Generous enough that a
// reconnect burst arrives in one call, bounded so a looping client cannot post unbounded volume.
const MaxLinesPerBatch = 200;

const batchSchema = z.object({
  lines: z.array(z.object({
    // Client clock. Trusted for ordering only - it is never used to decide anything, and two
    // clients' clocks disagreeing is itself worth being able to see.
    at: z.coerce.date(),
    category: z.string().trim().min(1).max(32),
    message: z.string().trim().min(1).max(2000),
    plugin_version: z.string().trim().max(64).optional(),
    session_id: z.string().trim().max(64).optional(),
    sequence: z.number().int().nonnegative().optional(),
    context: z.record(z.string(), z.unknown()).optional()
  })).min(1).max(MaxLinesPerBatch)
});

export async function clientLogRoutes(app: FastifyInstance): Promise<void> {
  app.post("/client-logs", async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ message: "Invalid log batch.", errors: parsed.error.flatten() });
    }

    const { lines } = parsed.data;

    // One statement for the whole batch. A row per INSERT would make a reconnect burst dozens of
    // round trips, and this runs on every controller's client continuously.
    await pool.query(
      `INSERT INTO client_logs
         (controller_cid,controller_callsign,category,message,logged_at,plugin_version,session_id,sequence,context)
       SELECT $1,$2,* FROM unnest($3::text[],$4::text[],$5::timestamptz[],$6::text[],$7::text[],$8::bigint[],$9::jsonb[])`,
      [request.controller.cid, request.controller.callsign,
       lines.map(line => line.category),
       lines.map(line => line.message),
       lines.map(line => line.at),
       lines.map(line => line.plugin_version ?? null),
       lines.map(line => line.session_id ?? null),
       lines.map(line => line.sequence ?? null),
       lines.map(line => line.context == null ? null : JSON.stringify(line.context))]);

    return reply.code(204).send();
  });

  // Reading them back. Ordered oldest-first because these are read as a narrative, and defaulting
  // to a recent window rather than the whole table - the interesting question is almost always
  // "what were all of them doing when this happened".
  app.get<{ Querystring: {
    since?: string; callsign?: string; category?: string; limit?: string;
    sector?: string; fdr_callsign?: string; request_id?: string; session_id?: string;
  } }>(
    "/client-logs", async request => {
      const since = request.query.since ?? "30 minutes";
      const limit = Math.min(Number(request.query.limit) || 500, 5000);

      const rows = await pool.query(
        `SELECT controller_cid,controller_callsign,category,message,logged_at,created_at,
                plugin_version,session_id,sequence,context
           FROM client_logs
          WHERE logged_at >= now()-$1::interval
            AND ($2::text IS NULL OR controller_callsign = $2)
            AND ($3::text IS NULL OR category = $3)
            AND ($4::text IS NULL OR session_id = $4)
            AND ($5::text IS NULL OR context->>'sector' = $5 OR context->'sectors' ? $5
                 OR context->'claimed' ? $5 OR context->'released' ? $5 OR context->'requested' ? $5
                 OR context->'skipped' ? $5 OR context->'transferred' ? $5)
            AND ($6::text IS NULL OR context->>'fdr_callsign' = $6 OR context->>'callsign' = $6)
            AND ($7::text IS NULL OR context->>'request_id' = $7 OR context->'request_ids' ? $7)
          ORDER BY logged_at, created_at, id
          LIMIT $8`,
        [since, request.query.callsign ?? null, request.query.category ?? null,
         request.query.session_id ?? null, request.query.sector ?? null,
         request.query.fdr_callsign ?? null, request.query.request_id ?? null, limit]);

      return rows.rows;
    });
}
