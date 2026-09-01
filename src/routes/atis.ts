import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";

const atisSchema = z.object({
  icao: z.string().trim().length(4).transform(value => value.toUpperCase()),
  atis_letter: z.string().length(1),
  content: z.record(z.string(), z.string().nullable()),
  frequency: z.number().int().nullable().optional()
}).passthrough();

export async function protectedAtisRoutes(app: FastifyInstance): Promise<void> {
  app.post("/atis", async (request, reply) => {
    const parsed = atisSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid ATIS.", errors: parsed.error.flatten() });
    const value = parsed.data;
    return (await pool.query(
      `INSERT INTO atis_broadcasts (icao,atis_letter,content,frequency,last_seen_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (icao) DO UPDATE SET atis_letter=$2,content=$3,frequency=$4,last_seen_at=now() RETURNING *`,
      [value.icao, value.atis_letter, JSON.stringify(value.content), value.frequency ?? null])).rows[0];
  });
}

export async function publicAtisRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { icao: string } }>("/atis/:icao", async request =>
    (await pool.query("SELECT * FROM atis_broadcasts WHERE icao=$1", [request.params.icao.toUpperCase()])).rows[0] ?? null);
}
