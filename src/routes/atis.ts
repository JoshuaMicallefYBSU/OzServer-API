import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseServer } from "../auth.js";
import { pool } from "../db.js";
import { ATIS_SECTIONS, atisTimestamp } from "../network-atis.js";

const atisSchema = z.object({
  icao: z.string().trim().length(4).transform(value => value.toUpperCase()),
  // A broadcast with no letter is not a broadcast - rejected rather than stored, the same rule the
  // network mirror applies to the datafeed (see network-atis.ts's vatpacAtis).
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

export async function publicAtisRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { icao: string }; Querystring: { server?: string } }>("/atis/:icao", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });
    return (await pool.query("SELECT * FROM atis_broadcasts WHERE icao=$1 AND server=$2", [request.params.icao.toUpperCase(), server])).rows[0] ?? null;
  });

  // Every VATPAC ATIS connected to the live VATSIM network, plugin user or not - mirrored from the
  // datafeed by network-atis-sync.ts. No ?server=: the datafeed only describes the live network.
  // content is the ATIS split into its sections (see network-atis.ts's atisContent) - every section
  // is always present, null when the broadcast doesn't include it. A station that has connected
  // without publishing a letter is not mirrored at all, so atis_letter is never null here.
  const networkAtisQuery = "SELECT icao,atis_code AS atis_letter,content,changed,last_updated FROM network_atis";

  type NetworkAtisRow = { content: string | Partial<Record<string, string | null>>; last_updated: Date | string | null };

  // jsonb does not keep key order (it stores them shortest-first), so content is rebuilt here in the
  // order the sections appear in the vatSys ATIS editor. A ZULU ATIS's content is its raw text (a
  // plain string), passed through untouched. last_updated is served as a DDHHMMz day-time group
  // rather than an ISO instant - the form an ATIS is actually read in.
  const forApi = (rows: NetworkAtisRow[]) =>
    rows.map(row => {
      const content = row.content;
      return {
        ...row,
        content: typeof content === "string" ? content
          : Object.fromEntries(ATIS_SECTIONS.map(section => [section, content[section] ?? null])),
        last_updated: atisTimestamp(row.last_updated)
      };
    });

  app.get("/vatsim/atis", async () =>
    forApi((await pool.query(`${networkAtisQuery} ORDER BY icao,callsign`)).rows));

  app.get<{ Params: { icao: string } }>("/vatsim/atis/:icao", async request =>
    forApi((await pool.query(`${networkAtisQuery} WHERE icao=$1 ORDER BY callsign`, [request.params.icao.toUpperCase()])).rows));
}
