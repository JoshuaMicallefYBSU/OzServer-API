import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";

// Shared notes and freehand drawing (issue #9). One controller marks up the radar picture, everyone
// sees it.
//
// Reads return every annotation rather than filtering by area or by sector. The whole set is a few
// dozen rows of small geometry, the plugin needs all of it to draw anything, and a filter would have
// to be recomputed on every pan and zoom - which is a round trip per scroll wheel notch to save
// nothing.
//
// Only the author may change or delete their own annotation. Shared visibility is not shared
// ownership: a note is a statement by a particular controller, and letting anyone edit it would make
// the callsign attached to it a lie.

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180)
});

// A stroke is capped rather than unbounded. Freehand input samples as fast as the mouse moves, so a
// single careless drag can produce thousands of points; the plugin thins its own strokes, and this
// is the backstop that stops one client filling the table and every other client's scope with a
// path nobody can see the shape of anyway.
const MaxStrokePoints = 2_000;

const createSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("note"),
    body: z.string().trim().min(1).max(500),
    // Exactly one point: a note is anchored where it was placed.
    points: z.tuple([pointSchema]),
    colour: z.string().trim().max(32).optional()
  }),
  z.object({
    kind: z.literal("stroke"),
    // Two points is the shortest thing that is still a line. One is a click, not a drawing.
    points: z.array(pointSchema).min(2).max(MaxStrokePoints),
    colour: z.string().trim().max(32).optional()
  })
]);

// Text and geometry are both editable - a note gets reworded, a stroke does not, but both move when
// dragged - and either may be sent alone.
const updateSchema = z.object({
  body: z.string().trim().min(1).max(500).optional(),
  points: z.array(pointSchema).min(1).max(MaxStrokePoints).optional()
}).refine(value => value.body !== undefined || value.points !== undefined, {
  message: "Nothing to update."
});

type AnnotationRow = {
  id: string;
  kind: string;
  author_cid: number;
  author_callsign: string;
  body: string | null;
  points: unknown;
  colour: string | null;
  created_at: Date;
  updated_at: Date;
};

function toDto(row: AnnotationRow) {
  return {
    id: row.id,
    kind: row.kind,
    author: { cid: row.author_cid, callsign: row.author_callsign },
    body: row.body,
    points: row.points,
    colour: row.colour,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function annotationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/annotations", async request => {
    // Touched on every read, which is the plugin's own heartbeat - it re-reads on connect and on
    // each annotations signal. That keeps the author's work alive for exactly as long as their
    // client is running, without needing a second keep-alive endpoint to call.
    await pool.query(
      "UPDATE annotations SET last_seen_online_at=now() WHERE author_cid=$1 AND author_callsign=$2",
      [request.controller.cid, request.controller.callsign]);

    return (await pool.query<AnnotationRow>(
      "SELECT * FROM annotations ORDER BY created_at")).rows.map(toDto);
  });

  app.post("/annotations", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ message: "Invalid annotation.", errors: parsed.error.flatten() });
    }

    const { kind, points, colour } = parsed.data;
    const body = kind === "note" ? parsed.data.body : null;

    const inserted = await pool.query<AnnotationRow>(
      `INSERT INTO annotations (kind,author_cid,author_callsign,body,points,colour)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [kind, request.controller.cid, request.controller.callsign, body, JSON.stringify(points), colour ?? null]);

    return reply.code(201).send(toDto(inserted.rows[0]!));
  });

  app.post<{ Params: { id: string } }>("/annotations/:id/update", async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ message: "Invalid annotation update.", errors: parsed.error.flatten() });
    }

    // COALESCE so an update carrying only one of the two leaves the other alone, rather than the
    // route having to build a different statement per combination.
    //
    // The author predicate is in the WHERE, not checked beforehand: a separate SELECT would leave a
    // gap in which the row could change hands or be deleted, and there is nothing to report
    // differently anyway - not yours and not there are the same answer to the caller.
    const updated = await pool.query<AnnotationRow>(
      `UPDATE annotations SET body=COALESCE($1,body), points=COALESCE($2::jsonb,points), updated_at=now(),
              last_seen_online_at=now()
        WHERE id=$3 AND author_cid=$4 AND author_callsign=$5 RETURNING *`,
      [parsed.data.body ?? null,
       parsed.data.points ? JSON.stringify(parsed.data.points) : null,
       request.params.id, request.controller.cid, request.controller.callsign]);

    return updated.rows[0]
      ? reply.send(toDto(updated.rows[0]))
      : reply.code(403).send({ message: "Only the author may change this annotation." });
  });

  app.post<{ Params: { id: string } }>("/annotations/:id/delete", async (request, reply) => {
    const deleted = await pool.query(
      "DELETE FROM annotations WHERE id=$1 AND author_cid=$2 AND author_callsign=$3",
      [request.params.id, request.controller.cid, request.controller.callsign]);

    return deleted.rowCount
      ? reply.code(204).send()
      : reply.code(403).send({ message: "Only the author may delete this annotation." });
  });

  // Clearing up after yourself in one call, for a controller signing off. Deliberately scoped to the
  // caller's own rows - there is no endpoint that clears somebody else's markup.
  app.post("/annotations/clear-mine", async (request, reply) => {
    await pool.query(
      "DELETE FROM annotations WHERE author_cid=$1 AND author_callsign=$2",
      [request.controller.cid, request.controller.callsign]);

    return reply.code(204).send();
  });
}
