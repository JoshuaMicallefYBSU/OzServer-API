import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeDiagnosticLog } from "../diagnostics.js";
import { pool, transaction } from "../db.js";
import type { ControllerIdentity } from "../types.js";

const flightSchema = z.object({
  callsign: z.string().trim().min(1).max(20),
  controlling_cid: z.number().int().nullable().optional(),
  controlling_callsign: z.string().max(32).nullable().optional(),
  current_sector: z.string().max(32).nullable().optional()
}).passthrough();

async function upsert(flights: Array<z.infer<typeof flightSchema>>, identity: ControllerIdentity) {
  return transaction(async client => {
    const cidsWithSectors = new Set((await client.query("SELECT DISTINCT controller_cid FROM sector_ownerships")).rows.map(row => row.controller_cid));
    const callerOwnedSectors = new Set((await client.query(
      `SELECT s.name FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
        WHERE o.controller_cid=$1`, [identity.cid])).rows.map(row => row.name));
    const results: Array<{ callsign: string; updated: boolean }> = [];
    for (const flight of flights) {
      const existing = (await client.query(
        "SELECT controlling_cid,controlling_callsign,current_sector,data FROM flight_data_records WHERE callsign=$1 FOR UPDATE", [flight.callsign])).rows[0];
      const updateSector = flight.current_sector ?? existing?.current_sector ?? null;
      const callerOwnsCurrentSector = updateSector != null && callerOwnedSectors.has(updateSector);
      // Whether the recorded authority is still worth protecting is answered entirely from our own
      // sector_ownerships bookkeeping (cidsWithSectors) - not, as this used to also require, from
      // the live VATSIM datafeed. That extra check was a second, independent lag source stacked on
      // top of a race that only needs seconds to matter:
      //
      // FdrSync queues a DTO the instant a give-away starts (OnFdrUpdate sees IsTrackedByMe still
      // true for the brief window between MMI.HandoffJurisdiction and the handoff PDU actually being
      // accepted), stamped with the giving controller's own identity - see FillAuthority. Nothing
      // ever revisits that queued DTO before it goes out on the next flush tick (every subsequent
      // update for that callsign is skipped by ShouldPush once IsTrackedByMe flips false), so every
      // ordinary give-away sends the giver's own stale self-authority claim 0-5 seconds later,
      // whether or not this rejection guard is even watching for it.
      //
      // Whether that stale claim lands harmlessly or clobbers the new authority used to depend on
      // whether online.get(existingCallsign) had caught up to the *new* authority yet - and the
      // public VATSIM datafeed, refreshed here through a 15s cache on top of VATSIM's own publish
      // interval, routinely takes tens of seconds to list a connection that only just claimed. A
      // transfer to a controller who had been online under a minute - exactly a claim-then-immediate
      // handoff, the ordinary shape of testing this - reliably lost the race: RCL14's authority
      // handed to BN-INL_CTR at :38 was silently overwritten by BN-MNN_CTR's stale give-away push at
      // :42, because online.get("BN-INL_CTR") still came back empty at that point despite BN-INL_CTR
      // being genuinely, currently connected and owning the sector outright.
      //
      // sector_ownerships has no such lag: last_seen_online_at is written by our own claim/accept/
      // resume/request-accept handlers the moment they run, not by an external feed on its own
      // schedule, so cidsWithSectors reflects a claim within the same request that made it - and it
      // is already grace-gated against a real drop by runMaintenance's disconnect sweep. Nothing
      // this guard actually needs was unique to the datafeed check; it only added a way to fail.
      if (existing?.controlling_cid && existing.controlling_cid !== identity.cid
        && cidsWithSectors.has(existing.controlling_cid)
        && !callerOwnsCurrentSector) {
        await writeDiagnosticLog(client, identity, "ServerFDR", `Rejected ${flight.callsign} update; authority is still ${existing.controlling_callsign}`, {
          action: "fdr_update_rejected",
          fdr_callsign: flight.callsign,
          reason: "existing_authority_holds_sectors",
          existing_authority: { cid: existing.controlling_cid, callsign: existing.controlling_callsign },
          attempted_authority: { cid: flight.controlling_cid ?? null, callsign: flight.controlling_callsign ?? null },
          attempted_state: flight.state ?? null,
          attempted_current_sector: flight.current_sector ?? null,
          update_sector: updateSector,
          caller_owns_current_sector: callerOwnsCurrentSector
        });
        results.push({ callsign: flight.callsign, updated: false });
        continue;
      }
      const { callsign, controlling_cid = null, controlling_callsign = null, current_sector = null,
        controller_cid: _callerCid, controller_callsign: _callerCallsign, ...data } = flight;
      const previousData = existing?.data ?? {};
      const previousState = previousData.state ?? null;
      const nextState = data.state ?? previousState;
      await client.query(
        `INSERT INTO flight_data_records (callsign,controlling_cid,controlling_callsign,current_sector,data,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (callsign) DO UPDATE SET
         controlling_cid=excluded.controlling_cid,controlling_callsign=excluded.controlling_callsign,
         current_sector=excluded.current_sector,data=flight_data_records.data || excluded.data,last_seen_at=now()`,
        [callsign, controlling_cid, controlling_callsign, current_sector, JSON.stringify(data)]);

      const changed = !existing
        || existing.controlling_cid !== controlling_cid
        || existing.controlling_callsign !== controlling_callsign
        || existing.current_sector !== current_sector
        || previousState !== nextState;

      if (changed) {
        await writeDiagnosticLog(client, identity, "ServerFDR", `Updated ${callsign} FDR authority/state`, {
          action: existing ? "fdr_transition" : "fdr_create",
          fdr_callsign: callsign,
          previous: existing ? {
            controlling_cid: existing.controlling_cid ?? null,
            controlling_callsign: existing.controlling_callsign ?? null,
            current_sector: existing.current_sector ?? null,
            state: previousState
          } : null,
          next: {
            controlling_cid,
            controlling_callsign,
            current_sector,
            state: nextState
          }
        });
      }
      results.push({ callsign, updated: true });
    }
    return results;
  });
}

export async function flightRoutes(app: FastifyInstance): Promise<void> {
  app.post("/fdr", async (request, reply) => {
    const parsed = flightSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid flight data.", errors: parsed.error.flatten() });
    await upsert([parsed.data], request.controller);
    return parsed.data;
  });
  app.post("/fdr/batch", async (request, reply) => {
    const parsed = z.object({ flights: z.array(flightSchema).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid flight batch.", errors: parsed.error.flatten() });
    return { results: await upsert(parsed.data.flights, request.controller) };
  });
  app.get("/fdr/sync", async () => (await pool.query(
    `SELECT callsign,controlling_cid,controlling_callsign,current_sector,last_seen_at,data
       FROM flight_data_records ORDER BY callsign`)).rows.map(row => ({ ...row.data, callsign: row.callsign,
         controlling_cid: row.controlling_cid, controlling_callsign: row.controlling_callsign,
         current_sector: row.current_sector, last_seen_at: row.last_seen_at })));
}
