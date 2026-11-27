import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { writeDiagnosticLog } from "../diagnostics.js";
import { pool, transaction } from "../db.js";
import { isWithinStartupGrace } from "../presence.js";
import type { ControllerIdentity } from "../types.js";

const flightSchema = z.object({
  callsign: z.string().trim().min(1).max(20),
  // An integer column: one value past its range failed the whole batch it came in.
  controlling_cid: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
  controlling_callsign: z.string().max(32).nullable().optional(),
  current_sector: z.string().max(32).nullable().optional(),
  // The FDR's vatSys data authority (fdr.ControllingSector) - kept in data like any other field,
  // and what an untracked push is recognised by (see reportsUntracked).
  authority_sector: z.string().max(32).nullable().optional()
}).passthrough();

// What GET /fdr/sync?view=state leaves out of each record: the flight plan as filed, its route,
// and the parts of the position only the map draws. A list of what to drop rather than what to
// keep, so a field added to the push later is served until somebody decides it is bulk. Whatever
// the plugin's poll reads must stay off it - LabelStateMirror and FdrResumeActivation in the
// plugin: the controller, state, cleared level, scratchpad and global ops, deviations, SSR code,
// ETD/ATD, authority sector, lat/lon, ground speed and on_ground.
const STATE_VIEW_OMITS = [
  "route_points", "route_next_index", "route", "sid_star_string", "runway_string", "departure_runway",
  "remarks", "flight_rules", "aircraft_type", "aircraft_wake", "aircraft_equip", "aircraft_surv_equip",
  "aircraft_count", "dep_airport", "des_airport", "dep_lat", "dep_lon", "des_lat", "des_lon",
  "rfl", "tas", "eta", "eet_minutes", "text_only", "receive_only",
  "altitude", "heading", "vertical_rate"
];

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// The times on a route (route_points' ato, est and hold - see the plugin's OzServerRoutePointDto),
// kept from the stored route when a push leaves them out. A client that never saw an estimate set,
// or one whose controller has just picked the tag up and not yet read it back from here
// (RouteTimesRestore), sends the route without it, and would otherwise erase it.
//
// - ato: always kept. A point passed stays passed.
// - est and hold: kept unless the push states them (route_times_known: the tracking controller's
//   own client, once it has the record's times), since only then is a missing one a cleared one.
//
// Points are paired in order by name, so a point the new route no longer has takes nothing with it.
type RoutePoint = Record<string, unknown> & { n?: unknown };
function mergeRouteTimes(pushed: unknown[], previous: unknown, stated: boolean): unknown[] {
  if (!Array.isArray(previous) || previous.length === 0) return pushed;
  const old = previous.filter((p): p is RoutePoint => !!p && typeof p === "object");
  let from = 0;
  return pushed.map(point => {
    if (!point || typeof point !== "object") return point;
    const next = point as RoutePoint;
    const index = old.findIndex((p, i) => i >= from && typeof p.n === "string" && p.n === next.n);
    if (index < 0) return point;
    from = index + 1;
    const kept: RoutePoint = { ...next };
    const keys = stated ? ["ato"] : ["ato", "est", "hold"];
    for (const key of keys) if (kept[key] == null && old[index][key] != null) kept[key] = old[index][key];
    return kept;
  });
}

async function upsert(flights: Array<z.infer<typeof flightSchema>>, identity: ControllerIdentity) {
  return transaction(async client => {
    const cidsWithSectors = new Set((await client.query("SELECT DISTINCT controller_cid FROM sector_ownerships WHERE server=$1", [identity.server])).rows.map(row => row.controller_cid));
    // Controllers whose client is still calling in (the heartbeat in app.ts). Everyone counts as
    // present just after this server starts, before anybody has had a chance to call.
    const presentCids = isWithinStartupGrace(config.PRESENCE_TIMEOUT_SECONDS * 1000) ? null : new Set((await client.query(
      `SELECT DISTINCT controller_cid FROM sector_ownerships
        WHERE server=$1 AND last_seen_online_at >= now()-($2*interval '1 second')`,
      [identity.server, config.PRESENCE_TIMEOUT_SECONDS])).rows.map(row => row.controller_cid));
    const callerOwnedSectors = new Set((await client.query(
      `SELECT s.name FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
        WHERE o.controller_cid=$1 AND o.server=$2`, [identity.cid, identity.server])).rows.map(row => row.name));
    const results: Array<{ callsign: string; updated: boolean }> = [];
    // Locked in one fixed order. Each row is taken FOR UPDATE below and held to the end of the
    // batch, so two batches naming the same aircraft in opposite orders would otherwise deadlock.
    const ordered = [...flights].sort((left, right) => left.callsign < right.callsign ? -1 : left.callsign > right.callsign ? 1 : 0);
    for (const flight of ordered) {
      const existing = (await client.query(
        "SELECT controlling_cid,controlling_callsign,current_sector,data FROM flight_data_records WHERE callsign=$1 AND server=$2 FOR UPDATE", [flight.callsign, identity.server])).rows[0];

      // An omitted field means "this partial push did not know", not "clear the existing value";
      // an explicit null still clears. FdrSync omits current_sector when SectorLocator cannot
      // resolve one, and the last good sector must survive that: resume and reassignment depend on
      // it.
      const controlling_cid = hasOwn(flight, "controlling_cid")
        ? flight.controlling_cid ?? null
        : existing?.controlling_cid ?? null;
      // Upper-cased like the caller's own identity (auth.ts): every later comparison of this column
      // is against identity.callsign - the accept transfer, release-all, the sweep - and a callsign
      // stored in another case would never match.
      const controlling_callsign = hasOwn(flight, "controlling_callsign")
        ? flight.controlling_callsign?.toUpperCase() ?? null
        : existing?.controlling_callsign ?? null;
      const current_sector = hasOwn(flight, "current_sector")
        ? flight.current_sector ?? null
        : existing?.current_sector ?? null;

      const updateSector = current_sector;
      const callerOwnsCurrentSector = updateSector != null && callerOwnedSectors.has(updateSector);
      // A push for a flight recorded under another controller is refused while that controller
      // still holds sectors. That is read from sector_ownerships (cidsWithSectors), which reflects
      // a claim within the request that made it, rather than from VATSIM's datafeed, which lags by
      // tens of seconds. The guard exists for the giver's late push in a handoff: FdrSync queues an
      // update stamped with the giver's identity as the give-away starts and sends it seconds
      // later, by which time the receiver may hold the aircraft.
      //
      // Exceptions:
      // - ownsSectorAndClaims: the caller owns the sector the aircraft is in. Not with a handover
      //   state - offering an aircraft is not a claim on it, and that is the shape of the giver's
      //   late push in a handoff made by hand.
      // - acceptsHandoff: the recorded authority's last push put the flight in handover, and the
      //   caller reports it controlled, by them. A handoff is accepted before the boundary, so the
      //   receiver does not yet own the sector the aircraft is in.
      // - reportsUntracked and keepAwayAuthority: see below.
      const isHandover = (state: unknown) => state === "STATE_HANDOVER" || state === "STATE_HANDOVER_FIRST";
      const recordedState = (existing?.data as { state?: unknown } | undefined)?.state;
      const acceptsHandoff = isHandover(recordedState)
        && flight.state === "STATE_CONTROLLED"
        && controlling_cid === identity.cid;
      const ownsSectorAndClaims = callerOwnsCurrentSector && !isHandover(flight.state);
      // An untracked report from the FDR's data authority: the plugin pushes an activated (or
      // completed) FDR that nobody tracks, from whichever controller holds the sector vatSys names
      // as its data authority (FdrSync.ShouldPush), with no tag owner. If the record still names
      // someone, they have since dropped the tag, so the authority holder is believed. Should that
      // be a moment's lag instead, the tracker's next push puts their name back: nothing guards a
      // record with no owner.
      const untrackedPush = hasOwn(flight, "controlling_cid") && flight.controlling_cid == null;
      // In handover the report is believed too, once vatSys shows somebody other than the recorded
      // controller tracking it (tracked_by): the handoff was accepted by a controller without the
      // plugin, who never reports. Their acceptance is the push that would have ended the
      // handover, so without this FDX656 stayed in handover under ML-BLA_CTR after ML_APP took it.
      // A give-away push cannot look like this: it comes from the recorded controller themselves,
      // still tracking.
      const trackedBy = typeof flight.tracked_by === "string" ? flight.tracked_by.toUpperCase() : "";
      const acceptedOutside = isHandover(recordedState) && trackedBy !== ""
        && trackedBy !== (existing?.controlling_callsign ?? "").toUpperCase();
      const reportsUntracked = untrackedPush
        && typeof flight.authority_sector === "string" && callerOwnedSectors.has(flight.authority_sector)
        && (!isHandover(recordedState) || acceptedOutside);
      // The recorded controller has dropped off: still holding sectors (the disconnect grace
      // period) but no longer calling. The plugin has one connected controller keep the aircraft's
      // position current meanwhile (FdrSync.ResponsibleSectorForUntracked), and that report is
      // taken. The recorded name stays, so they get the tag straight back if they reconnect within
      // the grace period (POST /sectors/resume). Once the sweep has released their sectors, an
      // untracked report clears it like any other.
      const authorityAway = !!existing?.controlling_cid && existing.controlling_cid !== identity.cid
        && cidsWithSectors.has(existing.controlling_cid)
        && presentCids !== null && !presentCids.has(existing.controlling_cid);
      const keepAwayAuthority = untrackedPush && authorityAway;
      if (existing?.controlling_cid && existing.controlling_cid !== identity.cid
        && cidsWithSectors.has(existing.controlling_cid)
        && !ownsSectorAndClaims
        && !acceptsHandoff
        && !reportsUntracked
        && !keepAwayAuthority) {
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

      // Standing in for a controller who has dropped off (keepAwayAuthority): the position and flight
      // data are this report's, the tag - who holds it, and its tracked state - stays theirs.
      const storedCid = keepAwayAuthority ? existing!.controlling_cid : controlling_cid;
      const storedCallsign = keepAwayAuthority ? existing!.controlling_callsign : controlling_callsign;
      if (keepAwayAuthority) delete data.state;

      const previousData = existing?.data ?? {};
      if (Array.isArray(data.route_points))
        data.route_points = mergeRouteTimes(data.route_points, previousData.route_points, data.route_times_known === true);
      delete data.route_times_known;
      const previousState = previousData.state ?? null;
      const nextState = data.state ?? previousState;
      await client.query(
        `INSERT INTO flight_data_records (callsign,controlling_cid,controlling_callsign,current_sector,data,last_seen_at,server)
         VALUES ($1,$2,$3,$4,$5,now(),$6) ON CONFLICT (callsign, server) DO UPDATE SET
         controlling_cid=excluded.controlling_cid,controlling_callsign=excluded.controlling_callsign,
         current_sector=excluded.current_sector,data=flight_data_records.data || excluded.data,last_seen_at=now()`,
        [callsign, storedCid, storedCallsign, current_sector, JSON.stringify(data), identity.server]);

      const changed = !existing
        || existing.controlling_cid !== storedCid
        || existing.controlling_callsign !== storedCallsign
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
            controlling_cid: storedCid,
            controlling_callsign: storedCallsign,
            current_sector,
            state: nextState
          },
          standing_in_for_away_controller: keepAwayAuthority || undefined
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
    // `updated` is false when the push was refused because another controller holds authority.
    const [result] = await upsert([parsed.data], request.controller);
    return { ...parsed.data, updated: result?.updated ?? false };
  });
  app.post("/fdr/batch", async (request, reply) => {
    const parsed = z.object({ flights: z.array(flightSchema).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid flight batch.", errors: parsed.error.flatten() });
    return { results: await upsert(parsed.data.flights, request.controller) };
  });
  // Every record, without its route. route_points is dozens of waypoints per flight and nothing
  // that reads this list uses it: the plugin polls it every few seconds for label state and for
  // what to activate on reconnect, and the map reads routes from /map/routes. `data - $2` drops
  // the keys in Postgres. GET /fdr/:callsign still returns everything.
  //
  // ?view=state leaves the flight plan out as well (STATE_VIEW_OMITS): what is left is who holds
  // each flight, its label and where it is, which is all that poll reads. The rest is most of
  // each record, fetched by every connected plugin every few seconds and read by none of them.
  // Without the parameter the answer is as it always was, for plugins released before it.
  app.get<{ Querystring: { view?: string } }>("/fdr/sync", async request => (await pool.query(
    `SELECT callsign,controlling_cid,controlling_callsign,current_sector,last_seen_at,data - $2::text[] AS data
       FROM flight_data_records WHERE server=$1 ORDER BY callsign`,
    [request.controller.server, request.query.view === "state" ? STATE_VIEW_OMITS : ["route_points"]])).rows.map(row => ({ ...row.data, callsign: row.callsign,
         controlling_cid: row.controlling_cid, controlling_callsign: row.controlling_callsign,
         current_sector: row.current_sector, last_seen_at: row.last_seen_at })));
  // The controller who owns a flight cancelled its FDR in vatSys (Finish, or Cancel in the flight
  // plan window): the record is deleted outright rather than left to age out. A pilot who simply
  // disconnects is not this - the plugin never calls it then, and the record stays for
  // FDR_RETAIN_MINUTES so a reconnect can be picked back up.
  //
  // Only the owner may: the controller the record names, or - when it names nobody - one who holds
  // the sector it is in or its data authority sector. Anyone else is refused, so one client's
  // cancel cannot remove a flight another controller is working.
  app.post<{ Params: { callsign: string } }>("/fdr/:callsign/cancel", async (request, reply) => {
    const identity = request.controller;
    const callsign = request.params.callsign;
    // Answered after COMMIT, not from inside the transaction - as in routes/sectors.ts.
    const outcome = await transaction(async (client): Promise<{ code: number; body: unknown }> => {
      const existing = (await client.query(
        `SELECT controlling_cid,controlling_callsign,current_sector,data FROM flight_data_records
          WHERE callsign=$1 AND server=$2 FOR UPDATE`, [callsign, identity.server])).rows[0];
      if (!existing) return { code: 404, body: { message: "No record for this callsign." } };

      let owner = existing.controlling_cid === identity.cid;
      if (!owner && existing.controlling_cid == null) {
        const authoritySector = (existing.data as { authority_sector?: unknown } | undefined)?.authority_sector;
        const sectors = [existing.current_sector, typeof authoritySector === "string" ? authoritySector : null]
          .filter((name): name is string => !!name);
        if (sectors.length > 0) {
          owner = (await client.query(
            `SELECT 1 FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
              WHERE o.controller_cid=$1 AND o.server=$2 AND s.name = ANY($3) LIMIT 1`,
            [identity.cid, identity.server, sectors])).rowCount! > 0;
        }
      }

      if (!owner) {
        await writeDiagnosticLog(client, identity, "ServerFDR", `Refused to delete ${callsign}; not the owning controller`, {
          action: "fdr_cancel_refused",
          fdr_callsign: callsign,
          existing_authority: { cid: existing.controlling_cid ?? null, callsign: existing.controlling_callsign ?? null },
          current_sector: existing.current_sector ?? null
        });
        return { code: 403, body: { message: "Only the controller who owns this flight can cancel it." } };
      }

      await client.query("DELETE FROM flight_data_records WHERE callsign=$1 AND server=$2", [callsign, identity.server]);
      await writeDiagnosticLog(client, identity, "ServerFDR", `Deleted ${callsign} - cancelled by its controller`, {
        action: "fdr_cancelled",
        fdr_callsign: callsign,
        previous: {
          controlling_cid: existing.controlling_cid ?? null,
          controlling_callsign: existing.controlling_callsign ?? null,
          current_sector: existing.current_sector ?? null,
          state: (existing.data as { state?: unknown } | undefined)?.state ?? null
        }
      });
      return { code: 200, body: { callsign, deleted: true } };
    });
    return reply.code(outcome.code).send(outcome.body);
  });

  // One flight's current record, for a client that has just gained jurisdiction over a tag (a
  // sector transfer) and needs the clearance data (CFL in particular) the previous controller
  // entered: MMI.AcceptJurisdiction moves who tracks the tag, not vatSys's local FDR fields.
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
