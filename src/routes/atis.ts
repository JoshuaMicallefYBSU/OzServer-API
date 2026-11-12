import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseServer, tokenMatches } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { publish } from "../events.js";
import { ATIS_SECTIONS, atisTimestamp, atisUpdateSchema } from "../network-atis.js";

const atisSchema = z.object({
  icao: z.string().trim().length(4).transform(value => value.toUpperCase()),
  // A broadcast with no letter is not a broadcast - rejected rather than stored.
  atis_letter: z.string().trim().length(1).transform(value => value.toUpperCase()),
  content: z.record(z.string(), z.string().nullable()),
  frequency: z.number().int().nullable().optional()
}).passthrough();

export async function protectedAtisRoutes(app: FastifyInstance): Promise<void> {
  app.post("/atis", async (request, reply) => {
    const parsed = atisSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid ATIS.", errors: parsed.error.flatten() });
    const value = parsed.data;
    return (await pool.query(
      `INSERT INTO atis_broadcasts (icao,atis_letter,content,frequency,last_seen_at,server) VALUES ($1,$2,$3,$4,now(),$5)
       ON CONFLICT (icao, server) DO UPDATE SET atis_letter=$2,content=$3,frequency=$4,last_seen_at=now() RETURNING *`,
      [value.icao, value.atis_letter, JSON.stringify(value.content), value.frequency ?? null, request.controller.server])).rows[0];
  });
}

// One row per airport, published by the vatSys ATIS plugin rather than mirrored from VATSIM's
// datafeed (see network-atis.ts). No ?server= anywhere below: an ATIS is broadcast on the live
// network, and a plugin that is not connected to it has no ATIS to publish.
const NETWORK_ATIS_COLUMNS = `icao,callsign,atis_letter,type,frequency,issued,content,changed,
  controller_callsign,controller_cid,client_name,client_version`;

type NetworkAtisRow = {
  icao: string;
  callsign: string;
  atis_letter: string;
  type: string;
  frequency: string | null;
  issued: Date | string | null;
  content: string | Partial<Record<string, string | null>>;
  changed: string[];
  controller_callsign: string;
  controller_cid: number;
  client_name: string | null;
  client_version: string | null;
};

// Built key by key rather than handing back the row: the response is the same shape the plugin PUT,
// so a body round-trips, and a column added later does not leak into it unasked. jsonb does not
// keep key order (it stores keys shortest-first), so content is rebuilt in the order the sections
// appear in the vatSys ATIS editor; a zulu ATIS's content is its raw text, passed through
// untouched. issued is served as a DDHHMMz day-time group - the form an ATIS time is read in.
function forApi(row: NetworkAtisRow) {
  const content = row.content;
  return {
    icao: row.icao,
    callsign: row.callsign,
    atis_letter: row.atis_letter,
    type: row.type,
    frequency: row.frequency,
    issued: atisTimestamp(row.issued),
    content: typeof content === "string" ? content
      : Object.fromEntries(ATIS_SECTIONS.map(section => [section, content[section] ?? null])),
    changed: row.changed,
    controller: { callsign: row.controller_callsign, cid: row.controller_cid },
    client: row.client_name === null ? null : { name: row.client_name, version: row.client_version }
  };
}

export async function publicAtisRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { icao: string }; Querystring: { server?: string } }>("/atis/:icao", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });
    return (await pool.query("SELECT * FROM atis_broadcasts WHERE icao=$1 AND server=$2", [request.params.icao.toUpperCase(), server])).rows[0] ?? null;
  });

  // Optional gate - see ATIS_TOKEN. Unset (the default) leaves publishing open to anyone who can
  // reach this API, which is no weaker than the datafeed mirror it replaces - that published
  // whatever VATSIM listed, and this server had no say in it at all - but it is this server's own
  // door now, so there is something to lock once the plugin can send a token.
  const mayPublish = (request: { headers: { authorization?: string }; query: { token?: string } }): boolean => {
    if (!config.ATIS_TOKEN) return true;
    const header = request.headers.authorization;
    const presented = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : request.query.token;
    return tokenMatches(presented, config.ATIS_TOKEN);
  };
  const denied = { message: "A valid token is required to publish an ATIS." };

  // Create or replace one airport's ATIS. Idempotent: the same body twice leaves the same row, and
  // only the status (201 the first time, 200 after) tells the two apart.
  app.put<{ Params: { icao: string }; Querystring: { token?: string } }>("/vatsim/atis/:icao", async (request, reply) => {
    if (!mayPublish(request)) return reply.code(401).send(denied);
    const parsed = atisUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid ATIS.", errors: parsed.error.flatten() });
    const atis = parsed.data;
    const icao = request.params.icao.trim().toUpperCase();
    // The URL names the record being replaced, so a body that disagrees with it is a mistake worth
    // answering rather than quietly resolving in favour of one or the other.
    if (atis.icao !== icao) {
      return reply.code(422).send({ message: `This ATIS is for ${atis.icao}, but the URL publishes ${icao}.` });
    }
    // `created` comes from Postgres's own xmax: zero on a row this statement inserted, non-zero on
    // one it updated - so the answer is 201 or 200 without a second query to find out which.
    const row = (await pool.query(
      `INSERT INTO network_atis (icao,callsign,atis_letter,type,frequency,issued,content,changed,
         controller_callsign,controller_cid,client_name,client_version,received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (icao) DO UPDATE SET callsign=$2,atis_letter=$3,type=$4,frequency=$5,issued=$6,content=$7,
         changed=$8,controller_callsign=$9,controller_cid=$10,client_name=$11,client_version=$12,received_at=now()
       RETURNING ${NETWORK_ATIS_COLUMNS},(xmax=0) AS created`,
      [icao, atis.callsign, atis.atis_letter, atis.type, atis.frequency, atis.issued,
        JSON.stringify(atis.content), atis.changed, atis.controller.callsign, atis.controller.cid,
        atis.client?.name ?? null, atis.client?.version ?? null])).rows[0] as NetworkAtisRow & { created: boolean };
    // Rides the existing "atis" signal, so anything already re-reading on it picks this up without
    // needing a new event type. Published after the write, never before it.
    await publish({ type: "atis", server: "live" });
    return reply.code(row.created ? 201 : 200).send(forApi(row));
  });

  // Take an airport's ATIS down - the controller running it has signed off. Answered 204 either
  // way: a plugin withdrawing an ATIS that is already gone has got what it asked for.
  app.delete<{ Params: { icao: string }; Querystring: { token?: string } }>("/vatsim/atis/:icao", async (request, reply) => {
    if (!mayPublish(request)) return reply.code(401).send(denied);
    const removed = await pool.query("DELETE FROM network_atis WHERE icao=$1", [request.params.icao.trim().toUpperCase()]);
    if (removed.rowCount) await publish({ type: "atis", server: "live" });
    return reply.code(204).send();
  });

  app.get("/vatsim/atis", async () =>
    (await pool.query<NetworkAtisRow>(`SELECT ${NETWORK_ATIS_COLUMNS} FROM network_atis ORDER BY icao`)).rows.map(forApi));

  // One airport, or null when nobody is running its ATIS - not a 404: "there is no ATIS for YSSY
  // right now" is an answer, and every caller here is polling rather than following a link.
  app.get<{ Params: { icao: string } }>("/vatsim/atis/:icao", async request =>
    (await pool.query<NetworkAtisRow>(`SELECT ${NETWORK_ATIS_COLUMNS} FROM network_atis WHERE icao=$1`,
      [request.params.icao.trim().toUpperCase()])).rows.map(forApi)[0] ?? null);
}
