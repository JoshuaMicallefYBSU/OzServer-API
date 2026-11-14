import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeDiagnosticLog } from "../diagnostics.js";
import { pool, transaction } from "../db.js";
import type { ControllerIdentity } from "../types.js";

const flightSchema = z.object({
  callsign: z.string().trim().min(1).max(20),
  controlling_cid: z.number().int().nullable().optional(),
  controlling_callsign: z.string().max(32).nullable().optional(),
  current_sector: z.string().max(32).nullable().optional(),
  // The FDR's vatSys data authority (fdr.ControllingSector) - kept in data like any other field,
  // and what an untracked push is recognised by (see reportsUntracked).
  authority_sector: z.string().max(32).nullable().optional()
}).passthrough();

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function upsert(flights: Array<z.infer<typeof flightSchema>>, identity: ControllerIdentity) {
  return transaction(async client => {
    const cidsWithSectors = new Set((await client.query("SELECT DISTINCT controller_cid FROM sector_ownerships WHERE server=$1", [identity.server])).rows.map(row => row.controller_cid));
    const callerOwnedSectors = new Set((await client.query(
      `SELECT s.name FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
        WHERE o.controller_cid=$1 AND o.server=$2`, [identity.cid, identity.server])).rows.map(row => row.name));
    const results: Array<{ callsign: string; updated: boolean }> = [];
    // Locked in one fixed order. Each row is taken FOR UPDATE below and held to the end of the
    // batch, so two controllers' batches naming the same two aircraft in opposite orders each took
    // one and waited for the other - a deadlock Postgres breaks by failing one whole batch.
    const ordered = [...flights].sort((left, right) => left.callsign < right.callsign ? -1 : left.callsign > right.callsign ? 1 : 0);
    for (const flight of ordered) {
      const existing = (await client.query(
        "SELECT controlling_cid,controlling_callsign,current_sector,data FROM flight_data_records WHERE callsign=$1 AND server=$2 FOR UPDATE", [flight.callsign, identity.server])).rows[0];

      // Optional means "this partial push did not know", not "clear the existing value". Explicit
      // null still clears. FdrSync deliberately omits current_sector when SectorLocator cannot
      // resolve one, so treating omission as null erased the last good sector and broke the resume
      // and reassignment decisions that depend on it.
      const controlling_cid = hasOwn(flight, "controlling_cid")
        ? flight.controlling_cid ?? null
        : existing?.controlling_cid ?? null;
      const controlling_callsign = hasOwn(flight, "controlling_callsign")
        ? flight.controlling_callsign ?? null
        : existing?.controlling_callsign ?? null;
      const current_sector = hasOwn(flight, "current_sector")
        ? flight.current_sector ?? null
        : existing?.current_sector ?? null;

      const updateSector = current_sector;
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
      //
      // One takeover is not a stale claim at all, and the guard used to refuse it with the rest:
      // the receiving end of a handoff the recorded authority made themselves. A controller hands
      // an aircraft on before it reaches the boundary, so the one accepting it does not own the
      // sector it is still in - and every push they made was turned away until the aircraft crossed,
      // or the previous controller logged off. ML-SNO_CTR accepted JST215 from ML-BLA_CTR on 13 Nov
      // and was refused every five seconds for two and a half minutes, with the record (and the map)
      // still naming a controller who had given the aircraft away.
      //
      // Recognised from the record itself: the authority's own last push put the flight in
      // handover, and the caller now reports it controlled, by them. The give-away push this guard
      // exists for cannot look like that - it carries the giver's handover state, not a controlled
      // one - so it is still refused exactly as before.
      //
      // And for the same reason a handover state never *takes* authority, even from the owner of
      // the sector the aircraft is in. That is precisely the shape of the give-away push in a
      // handoff made by hand: the giver still owns the sector, so owning it used to let their late
      // push put their own name back on an aircraft the receiver had already accepted. Offering an
      // aircraft is not a claim on it - the giver either gets it accepted (the receiver's controlled
      // push stands) or cancels (their own controlled push takes it back through the ordinary rule).
      const isHandover = (state: unknown) => state === "STATE_HANDOVER" || state === "STATE_HANDOVER_FIRST";
      const recordedState = (existing?.data as { state?: unknown } | undefined)?.state;
      const acceptsHandoff = isHandover(recordedState)
        && flight.state === "STATE_CONTROLLED"
        && controlling_cid === identity.cid;
      const ownsSectorAndClaims = callerOwnsCurrentSector && !isHandover(flight.state);
      // An untracked report from the FDR's data authority: the plugin now also pushes an activated
      // (or completed) FDR that nobody tracks, from whichever controller holds the sector vatSys
      // names as its data authority (FdrSync.ShouldPush), with no tag owner. If the record still
      // names someone, it is because they have since dropped the tag - their client sees it as
      // tracked and would not be pushing it untracked - so the authority holder is believed. Should
      // that ever be a moment's lag (a track the authority's client has not heard of yet), the
      // tracker's own next push puts their name straight back: nothing guards a record with no owner.
      const reportsUntracked = hasOwn(flight, "controlling_cid") && flight.controlling_cid == null
        && typeof flight.authority_sector === "string" && callerOwnedSectors.has(flight.authority_sector)
        && !isHandover(recordedState);
      if (existing?.controlling_cid && existing.controlling_cid !== identity.cid
        && cidsWithSectors.has(existing.controlling_cid)
        && !ownsSectorAndClaims
        && !acceptsHandoff
        && !reportsUntracked) {
        await writeDiagnosticLog(client, identity, "ServerFDR", `Rejected ${flight.callsign} update; authority is still ${existing.controlling_callsign}`, {
          action: "fdr_update_rejected",
          fdr_callsign: flight.callsign,
          reason: callerOwnsCurrentSector ? "handover_state_does_not_take_authority" : "existing_authority_holds_sectors",
          recorded_state: recordedState ?? null,
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
      const callsign = flight.callsign;
      const data: Record<string, unknown> = { ...flight };
      delete data.callsign;
      delete data.controlling_cid;
      delete data.controlling_callsign;
      delete data.current_sector;
      delete data.controller_cid;
      delete data.controller_callsign;
      delete data.server;

      const previousData = existing?.data ?? {};
      const previousState = previousData.state ?? null;
      const nextState = data.state ?? previousState;
      await client.query(
        `INSERT INTO flight_data_records (callsign,controlling_cid,controlling_callsign,current_sector,data,last_seen_at,server)
         VALUES ($1,$2,$3,$4,$5,now(),$6) ON CONFLICT (callsign, server) DO UPDATE SET
         controlling_cid=excluded.controlling_cid,controlling_callsign=excluded.controlling_callsign,
         current_sector=excluded.current_sector,data=flight_data_records.data || excluded.data,last_seen_at=now()`,
        [callsign, controlling_cid, controlling_callsign, current_sector, JSON.stringify(data), identity.server]);

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
    // `updated` is false when the push was refused because another controller holds authority -
    // this used to answer with the submitted flight either way, which read as success.
    const [result] = await upsert([parsed.data], request.controller);
    return { ...parsed.data, updated: result?.updated ?? false };
  });
  app.post("/fdr/batch", async (request, reply) => {
    const parsed = z.object({ flights: z.array(flightSchema).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid flight batch.", errors: parsed.error.flatten() });
    return { results: await upsert(parsed.data.flights, request.controller) };
  });
  app.get("/fdr/sync", async request => (await pool.query(
    `SELECT callsign,controlling_cid,controlling_callsign,current_sector,last_seen_at,data
       FROM flight_data_records WHERE server=$1 ORDER BY callsign`, [request.controller.server])).rows.map(row => ({ ...row.data, callsign: row.callsign,
         controlling_cid: row.controlling_cid, controlling_callsign: row.controlling_callsign,
         current_sector: row.current_sector, last_seen_at: row.last_seen_at })));
  // One flight's current record - for a client that just gained jurisdiction over a tag (a sector
  // transfer) and needs the clearance data (CFL in particular) the previous controller had already
  // entered, which nothing about accepting jurisdiction itself carries: MMI.AcceptJurisdiction only
  // ever moves who is tracking the tag, never any of vatSys's own local FDR fields.
  app.get<{ Params: { callsign: string } }>("/fdr/:callsign", async (request, reply) => {
    const row = (await pool.query(
      `SELECT callsign,controlling_cid,controlling_callsign,current_sector,last_seen_at,data
         FROM flight_data_records WHERE server=$1 AND callsign=$2`,
      [request.controller.server, request.params.callsign])).rows[0];
    if (!row) return reply.code(404).send({ message: "No record for this callsign." });
    return { ...row.data, callsign: row.callsign, controlling_cid: row.controlling_cid,
      controlling_callsign: row.controlling_callsign, current_sector: row.current_sector, last_seen_at: row.last_seen_at };
  });
}
