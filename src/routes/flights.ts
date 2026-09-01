import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, transaction } from "../db.js";
import { onlineControllers } from "../vatsim.js";

const flightSchema = z.object({
  callsign: z.string().trim().min(1).max(20),
  controlling_cid: z.number().int().nullable().optional(),
  controlling_callsign: z.string().max(32).nullable().optional(),
  current_sector: z.string().max(32).nullable().optional()
}).passthrough();

async function upsert(flights: Array<z.infer<typeof flightSchema>>, callerCid: number) {
  const online = await onlineControllers();
  return transaction(async client => {
    const cidsWithSectors = new Set((await client.query("SELECT DISTINCT controller_cid FROM sector_ownerships")).rows.map(row => row.controller_cid));
    const results: Array<{ callsign: string; updated: boolean }> = [];
    for (const flight of flights) {
      const existing = (await client.query(
        "SELECT controlling_cid,controlling_callsign FROM flight_data_records WHERE callsign=$1 FOR UPDATE", [flight.callsign])).rows[0];
      if (existing?.controlling_cid && existing.controlling_cid !== callerCid
        && cidsWithSectors.has(existing.controlling_cid)
        && online?.get(existing.controlling_callsign?.toUpperCase()) === existing.controlling_cid) {
        results.push({ callsign: flight.callsign, updated: false });
        continue;
      }
      const { callsign, controlling_cid = null, controlling_callsign = null, current_sector = null,
        controller_cid: _callerCid, controller_callsign: _callerCallsign, ...data } = flight;
      await client.query(
        `INSERT INTO flight_data_records (callsign,controlling_cid,controlling_callsign,current_sector,data,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (callsign) DO UPDATE SET
         controlling_cid=excluded.controlling_cid,controlling_callsign=excluded.controlling_callsign,
         current_sector=excluded.current_sector,data=flight_data_records.data || excluded.data,last_seen_at=now()`,
        [callsign, controlling_cid, controlling_callsign, current_sector, JSON.stringify(data)]);
      results.push({ callsign, updated: true });
    }
    return results;
  });
}

export async function flightRoutes(app: FastifyInstance): Promise<void> {
  app.post("/fdr", async (request, reply) => {
    const parsed = flightSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid flight data.", errors: parsed.error.flatten() });
    await upsert([parsed.data], request.controller.cid);
    return parsed.data;
  });
  app.post("/fdr/batch", async (request, reply) => {
    const parsed = z.object({ flights: z.array(flightSchema).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid flight batch.", errors: parsed.error.flatten() });
    return { results: await upsert(parsed.data.flights, request.controller.cid) };
  });
  app.get("/fdr/sync", async () => (await pool.query(
    `SELECT callsign,controlling_cid,controlling_callsign,current_sector,last_seen_at,data
       FROM flight_data_records ORDER BY callsign`)).rows.map(row => ({ ...row.data, callsign: row.callsign,
         controlling_cid: row.controlling_cid, controlling_callsign: row.controlling_callsign,
         current_sector: row.current_sector, last_seen_at: row.last_seen_at })));
}
