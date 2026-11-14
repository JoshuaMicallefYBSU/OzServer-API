import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { config } from "../config.js";
import { writeDiagnosticLog } from "../diagnostics.js";
import { pool, transaction } from "../db.js";
import { isWithinStartupGrace } from "../presence.js";
import {
  clearFlightsWithoutCurrentSectorOwner,
  reassignFreedSectors,
  transferFlightsInSectorsToOwner,
  transferFlightsToCurrentSectorOwners
} from "../grouping.js";
import type { ControllerIdentity } from "../types.js";

type SectorRow = {
  id: string; name: string; full_name: string; callsign: string | null; type: string | null;
  responsible_sectors: string[]; controller_cid: number | null;
  controller_callsign: string | null; last_seen_online_at: Date | null;
};

// Flow (FMP) positions claim flow sectors and nothing else. An FMP controller transmits on enroute
// and TMA lines to talk to those units, and every press used to claim the line's sector: PH_FMP
// ended up owning AAE (with AAR and AAW), PHA and HYD on 14 Nov, none of which anybody was working.
// What an FMP may do is provide relief cover: request a sector another controller holds, and take
// it the ordinary way if they accept. So claims of anything else are refused, and so is a request
// for a sector nobody holds; requests for held sectors, and their acceptance, are left alone. The
// plugin applies the same rule (PrimaryPosition.MayOwn). A sector's type is its callsign suffix
// (see sync-dataset).
function isFlowCallsign(callsign: string | null | undefined): boolean {
  return Boolean(callsign && /_FMP$/i.test(callsign));
}

function isFlowSector(sector: { type?: string | null; callsign?: string | null }): boolean {
  return sector.type?.toUpperCase() === "FMP" || isFlowCallsign(sector.callsign);
}

function mayOwn(identity: { callsign: string }, sector: { type?: string | null; callsign?: string | null }): boolean {
  return !isFlowCallsign(identity.callsign) || isFlowSector(sector);
}

const flowOnlyMessage = "Unable to assume sector - position is FMP. An FMP can only request a sector another controller holds, as relief cover.";

const sectorNames = z.array(z.string().max(32)).max(400);

const mutationSchema = z.object({
  claim: sectorNames.default([]),
  release: sectorNames.default([]),
  request: sectorNames.default([]),
  // Applied to every sector in `claim` - see claimGroup's `exclusions`.
  exclude: sectorNames.default([]),
  // See claimGroup's `primaryGroup`.
  primary_group: sectorNames.optional()
});

// The single-sector claim's body. Everything is optional: a plain claim sends nothing but its
// identity.
const claimSchema = z.object({
  exclude: sectorNames.default([]),
  primary_group: sectorNames.optional()
});

// Validated rather than trusted. These used to go to Postgres as whatever arrived - a non-numeric
// id, or request_ids that was not an array - and came back as a 500 from a type error deep in a
// query, logged as a server fault for what was simply a malformed request.
const requestIdSchema = z.coerce.number().int().positive();
const requestIdsSchema = z.object({ request_ids: z.array(requestIdSchema).max(400).default([]) });

async function lockMutations(client: pg.PoolClient, server: string): Promise<void> {
  // Sector groups overlap. One transaction-wide lock makes the complete check-and-write operation
  // atomic, including claims involving responsible sectors and batch commits. Keyed per server
  // (hashtext into Postgres's two-int-arg advisory lock overload) so a live commit and a sweatbox
  // commit never wait on each other for no reason - they touch entirely disjoint rows.
  await client.query("SELECT pg_advisory_xact_lock(684276, hashtext($1))", [server]);
}

// Bounded the same way the plugin's own tree recursion is (PrimaryPosition.CollectDefaultSectors,
// OzServerSectorsWindow.BuildOwnedSectorNode), against a cyclical grouping in the dataset.
const MAX_GROUP_DEPTH = 8;

// Everything claiming `name` covers: the sector itself plus its responsible sectors, all the way
// down.
//
// This used to expand one level only, which silently disagreed with every client that assumes
// otherwise. The plugin's PrimaryPosition is fully recursive and its comment says so explicitly,
// citing the old backend's own recursive coveredSectors() - that recursion did not survive the
// rewrite. 19 sectors in the current vatSys dataset are bundled by a group and bundle further
// sub-sectors themselves, so a controller logging onto a top-level group got the full airspace on
// their scope while OzServer recorded ownership one level down, leaving the deepest sub-sectors
// unowned and sitting in Available.
//
// `sectors` itself is shared across every server (it is static airspace geometry, not
// per-controller state - see migrations/006_server_isolation.sql), so only the ownership join is
// scoped to `server`, and it is scoped in the join condition rather than a WHERE filter: a WHERE
// filter would turn this into an inner join and silently drop a sector nobody has claimed yet on
// this server, instead of returning it with a null owner the way an unowned sector should read.
async function covered(client: pg.PoolClient, name: string, server: string): Promise<SectorRow[]> {
  const primary = await client.query<SectorRow>(
    `SELECT s.*, o.controller_cid, o.controller_callsign, o.last_seen_online_at
       FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id AND o.server=$2 WHERE s.name=$1`,
    [name, server]);
  const sector = primary.rows[0];
  if (!sector) return [];

  // Seeded with the sector's own name so that a sector which is both directly controllable and a
  // group - and therefore lists itself among its own responsible sectors - terminates instead of
  // expanding forever.
  const names = new Set<string>([sector.name]);
  let frontier = (sector.responsible_sectors ?? []).filter(child => !names.has(child));
  for (const child of frontier) names.add(child);

  for (let depth = 0; depth < MAX_GROUP_DEPTH && frontier.length > 0; depth++) {
    const children = (await client.query<{ responsible_sectors: string[] | null }>(
      "SELECT responsible_sectors FROM sectors WHERE name = ANY($1)", [frontier]))
      .rows.flatMap(row => row.responsible_sectors ?? []);
    frontier = [...new Set(children)].filter(child => !names.has(child));
    for (const child of frontier) names.add(child);
  }

  return (await client.query<SectorRow>(
    `SELECT s.*, o.controller_cid, o.controller_callsign, o.last_seen_online_at
       FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id AND o.server=$2 WHERE s.name = ANY($1)`,
    [[...names], server])).rows;
}

// Whether this row's owner is still actively connected, for the narrow purpose of deciding whether
// a DIFFERENT controller may claim their sector outright right now. Deliberately measured in
// PRESENCE_TIMEOUT_SECONDS, not DISCONNECT_GRACE_MINUTES: those answer different questions. This
// one is "is anyone actively there to object", and it has to be short - a controller whose
// connection just dropped should not keep a sector another controller wants locked to them for
// minutes on end. DISCONNECT_GRACE_MINUTES answers a slower, different question for a sector
// nobody has stepped up to claim at all - runMaintenance still uses that one to eventually hand an
// unclaimed sector to a covering parent position, and it is untouched by this.
function isPresent(row: SectorRow): boolean {
  // See presence.ts: right after this process starts, every row looks exactly as stale as this
  // process's own downtime was long, regardless of whether its owner ever actually left. Treating
  // that as "gone" here would let a claim take a still-connected controller's sector away because
  // of an outage of ours, not a disconnect of theirs - so during that window this always answers as
  // if the owner were present, the same way runMaintenance holds off deleting their row at all.
  //
  // Passed PRESENCE_TIMEOUT_SECONDS here, deliberately not DISCONNECT_GRACE_MINUTES: this check
  // runs on the same few-second timescale it always does, so it only needs enough startup grace for
  // one real poll cycle to land, not the full five minutes runMaintenance's own, much slower sweep
  // needs. Passing the longer window here once silently overrode fast claim-takeover back to a
  // five-minute wait for the first five minutes after every restart - caught by actually running
  // this against a freshly-started instance, not by reading the code.
  if (isWithinStartupGrace(config.PRESENCE_TIMEOUT_SECONDS * 1000)) return true;
  return row.last_seen_online_at !== null
    && Date.now() - new Date(row.last_seen_online_at).getTime() < config.PRESENCE_TIMEOUT_SECONDS * 1000;
}

// exclusions are sectors the claimer has asked to be left out of the expansion entirely - not
// taken, not conflict-checked, not reported.
//
// Two things send them. A client retrying after a 409 carves out whatever turned out to be owned by
// somebody else, so one contested sub-sector does not fail the whole claim. And every claim carves
// out the covered sectors somebody is currently logged on as - which is what stops an enroute
// controller taking an approach controller's sectors top-down while that controller is online.
//
// The client still sends fast, vatSys-live exclusions using PrimaryPosition.StaffedCoveredSectors.
// This server also treats sectors already owned by a staffed child position inside the same claim
// as "withheld", not conflicted, while that child controller is still actively present (isPresent,
// below) - not, as this used to also require, confirmed online through VATSIM's public datafeed.
// That extra confirmation was never needed for this specific case: the child position is in
// sector_ownerships because it claimed through this same plugin, and last_seen_online_at is kept
// current by every request that plugin makes, refreshed the instant they claimed and continuously
// afterwards - a strictly faster and more direct signal than a third-party feed with its own publish
// lag could ever be for a controller this server already has a direct relationship with. This still
// protects against stale or incomplete client exclusions: an enroute controller logging on over an
// already-online APP/TCU keeps the uncontested ENR sectors, the APP/TCU keeps its sectors, and the
// client does not receive a 409 that would create a request popup/error.
//
// isPresent's own window (PRESENCE_TIMEOUT_SECONDS) is short, not DISCONNECT_GRACE_MINUTES: once
// the child controller's connection actually drops, a parent/primary claim - or any other direct
// claim - may take the sector back within seconds, not minutes. A dropped connection is not a
// reservation; the slower DISCONNECT_GRACE_MINUTES window still applies afterwards, but only to the
// separate question of when runMaintenance eventually hands an unclaimed sector to a covering
// parent on its own, for whenever nobody claims it directly at all.
async function claimGroup(
  client: pg.PoolClient,
  identity: ControllerIdentity,
  name: string,
  exclusions: string[] = [],
  allOrNothing = false,
  primaryGroup?: string[]
): Promise<{ claimed: string[]; skipped: string[]; withheld: string[]; conflicts: Array<{ sector: string; owner: { cid: number; callsign: string } }>; missing: boolean; refused: string[] }> {
  const everything = await covered(client, name, identity.server);
  // Only a sector that does not exist is "missing". A claim whose exclusions leave nothing to take
  // names a real sector and simply has nothing to do, which is how a client retries after a 409
  // that contested every sector it covers: it carves all of them out and asks for the rest. That
  // came back 404 "Sector not found." - shown to a controller logging on to a position someone
  // present was holding, about a sector that exists and that they had just requested.
  if (everything.length === 0) return { claimed: [], skipped: [], withheld: [], conflicts: [], missing: true, refused: [] };
  // Sectors this controller may never hold at all - see isFlowCallsign. Not conflicts (there is
  // nobody to ask) and not withheld (it will not become claimable later); simply not taken.
  const refused = everything.filter(row => !mayOwn(identity, row)).map(row => row.name);
  if (refused.length > 0) {
    await writeDiagnosticLog(client, identity, "ServerSector", `Claim ${name}: refused ${refused.join(", ")} - flow positions hold FMP sectors only`, {
      action: "claim_refused_flow_position",
      sector: name,
      refused
    });
  }
  if (refused.includes(name)) return { claimed: [], skipped: [], withheld: [], conflicts: [], missing: false, refused };
  const rows = everything.filter(row => !exclusions.includes(row.name) && !refused.includes(row.name));
  if (rows.length === 0) return { claimed: [], skipped: [], withheld: [], conflicts: [], missing: false, refused };
  const takeable: SectorRow[] = [];
  const skipped: string[] = [];
  const withheld: string[] = [];
  const conflicts: Array<{ sector: string; owner: { cid: number; callsign: string } }> = [];
  // Worked out from everything the claim covers, before the exclusions are applied. The client
  // excludes the sectors a logged-on controller's position is made of as *it* understands that
  // position, which is not always everything this server records them as holding inside the group
  // (CBW sits under SNO here but is not part of SNO's position there). Computed from what was left
  // after the exclusions, the staffed sector itself was already gone, so nothing identified its
  // controller as logged on inside the group and the leftover sector came back as a conflict - a
  // "request it?" prompt about airspace this rule exists to leave alone quietly.
  const positionOwnersInClaim = new Set(everything
    .filter(row => row.controller_callsign
      && row.callsign?.toUpperCase() === row.controller_callsign.toUpperCase())
    .map(row => row.controller_callsign!.toUpperCase()));
  // No claim takes a sector off a controller who is present - not even a primary logging on to
  // their own position. That used to be allowed for the position's group (primary_group): BLA
  // logging on took BLA, ELW and MAE straight off the Huon controller holding them, with no request
  // and nothing on Huon's side expecting it, and the aircraft inside went with them mid-session. A
  // present owner is now always a conflict, and the arriving client turns its own position's
  // conflicts into one request to the holder (OzServerOwnershipTracker.HandleConflictAsync), so the
  // controller working the airspace is the one who decides when it moves.
  //
  // primary_group is still accepted from clients that send it, and ignored.
  void primaryGroup;

  for (const row of rows) {
    if (row.controller_cid === null || row.controller_cid === identity.cid) {
      takeable.push(row);
      continue;
    }
    const ownerHasPositionInThisClaim = positionOwnersInClaim.has(row.controller_callsign?.toUpperCase() ?? "");
    // last_seen_online_at alone answers whether this row's owner is still actively present - see
    // isPresent. This used to be a fallback, only consulted when the VATSIM public datafeed didn't
    // already confirm the owner online, and gated on the much longer DISCONNECT_GRACE_MINUTES; both
    // are gone now (see flights.ts and maintenance.ts for the same datafeed change, and why isPresent
    // for its own reasoning on the shorter window). A controller's connection dropping should not
    // lock their sector to them for minutes on end against someone who wants to claim it right now -
    // sector_ownerships keeps the row around, and TagResumeRecovery/PrimaryPosition's own claim on
    // reconnect naturally picks it back up if nobody else has taken it in the meantime, but nothing
    // here should make another controller wait out a reservation to take over a sector that isn't
    // actively being worked any more.
    if (isPresent(row)) {
      // Withholding is for what a claim merely sweeps up. The sector the claim *names* is the one
      // thing the claimant asked for outright, and answering 201 with it quietly left out told the
      // client it had succeeded: the sector stayed on their scope, unowned, and was claimed again
      // on every poll (SNO, once a second, for five minutes on 13 Nov) with no request ever raised
      // and nothing on either side to say why. A named sector someone present holds is a conflict
      // like any other, so the claimant is told and can ask for it.
      if (ownerHasPositionInThisClaim && row.name !== name) {
        withheld.push(row.name);
        continue;
      }
      skipped.push(row.name);
      conflicts.push({ sector: row.name, owner: { cid: row.controller_cid, callsign: row.controller_callsign ?? "" } });
    }
    else takeable.push(row);
  }

  if (allOrNothing && conflicts.length) {
    await writeDiagnosticLog(client, identity, "ServerSector", `Claim ${name} blocked by existing owner`, {
      action: "claim_blocked",
      sector: name,
      skipped,
      withheld,
      conflicts,
      exclusions,
      all_or_nothing: allOrNothing
    });
    return { claimed: [], skipped, withheld, conflicts, missing: false, refused };
  }

  const previousOwners = takeable
    .filter(row => row.controller_cid !== null && row.controller_cid !== identity.cid)
    .map(row => ({ sector: row.name, cid: row.controller_cid, callsign: row.controller_callsign }));

  for (const row of takeable) {
    await client.query(
      `INSERT INTO sector_ownerships (sector_id, controller_cid, controller_callsign, last_seen_online_at, server)
       VALUES ($1,$2,$3,now(),$4) ON CONFLICT (sector_id, server) DO UPDATE SET
       controller_cid=excluded.controller_cid, controller_callsign=excluded.controller_callsign,
       last_seen_online_at=now(), updated_at=now()`, [row.id, identity.cid, identity.callsign, identity.server]);
  }
  const transferredFlights = await transferFlightsInSectorsToOwner(
    client,
    takeable.map(row => ({ sector: row.name, cid: row.controller_cid, callsign: row.controller_callsign })),
    identity);

  // Requests this claim has made meaningless. One still pending against a sector that just changed
  // hands names a target who no longer owns it: nobody can accept it (transferRequest checks both),
  // the requester sees it pending forever, cannot ask again (one request per sector), and their
  // client stays on its fast poll waiting for an answer that cannot come. And the claimant's own
  // request for a sector they now hold has been overtaken by events. Both simply go - a request
  // disappearing is what the requester's client already sees on an accept or a cancel.
  await client.query(
    `DELETE FROM sector_requests
      WHERE server=$3
        AND ((sector_id=ANY($1) AND rejected_at IS NULL) OR (sector_id=ANY($2) AND requesting_cid=$4))`,
    [takeable.filter(row => row.controller_cid !== null && row.controller_cid !== identity.cid).map(row => row.id),
     takeable.map(row => row.id), identity.server, identity.cid]);

  if (takeable.length > 0 || skipped.length > 0 || withheld.length > 0 || exclusions.length > 0) {
    await writeDiagnosticLog(client, identity, "ServerSector", `Claim ${name}: ${takeable.length} claimed, ${skipped.length} skipped, ${withheld.length} withheld`, {
      action: "claim",
      sector: name,
      claimed: takeable.map(row => row.name),
      skipped,
      withheld,
      conflicts,
      exclusions,
      previous_owners: previousOwners,
      fdr_authority_transferred: transferredFlights,
      all_or_nothing: allOrNothing
    });
  }

  return { claimed: takeable.map(row => row.name), skipped, withheld, conflicts, missing: false, refused };
}

async function requestsPayload(client: pg.Pool | pg.PoolClient, identity: ControllerIdentity) {
  const rows = (await client.query(
    `SELECT r.*, s.name AS sector_name, s.full_name AS sector_full_name
       FROM sector_requests r JOIN sectors s ON s.id=r.sector_id
      WHERE (r.requesting_cid=$1 OR r.target_cid=$1) AND r.server=$2 ORDER BY r.created_at`,
    [identity.cid, identity.server])).rows;
  const map = (row: Record<string, unknown>) => ({
    id: Number(row.id), sector_id: Number(row.sector_id), group_id: row.group_id,
    requesting_cid: row.requesting_cid,
    requesting_callsign: row.requesting_callsign, target_cid: row.target_cid,
    target_callsign: row.target_callsign, rejected_at: row.rejected_at,
    sector: { id: Number(row.sector_id), name: row.sector_name, full_name: row.sector_full_name }
  });
  const fromMe = rows.filter(row => row.requesting_cid === identity.cid).map(map);
  return {
    by_me: fromMe,
    from_me: rows.filter(row => row.target_cid === identity.cid && !row.rejected_at).map(map)
  };
}

async function syncPayload(client: pg.Pool | pg.PoolClient, identity: ControllerIdentity) {
  const mine = (await client.query(
    `SELECT s.id,s.name,s.full_name FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
      WHERE o.controller_cid=$1 AND o.server=$2 ORDER BY s.name`, [identity.cid, identity.server])).rows.map(row => ({ ...row, id: Number(row.id) }));
  const controlled = (await client.query(
    `SELECT s.name,s.full_name,s.type,s.callsign,s.frequency,o.controller_cid AS cid,o.controller_callsign AS owner_callsign
       FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
      WHERE o.controller_cid<>$1 AND o.server=$2 ORDER BY s.name`, [identity.cid, identity.server])).rows.map(row => ({
        name: row.name, full_name: row.full_name, type: row.type, callsign: row.callsign,
        frequency: row.frequency, owner: { cid: row.cid, callsign: row.owner_callsign }
      }));
  return { mine, controlled, requests: await requestsPayload(client, identity) };
}

async function releaseGroup(client: pg.PoolClient, identity: ControllerIdentity, name: string): Promise<boolean> {
  const rows = await covered(client, name, identity.server);
  const primary = rows.find(row => row.name === name);
  if (!primary || primary.controller_cid !== identity.cid) return false;
  const released = rows.filter(row => row.controller_cid === identity.cid);
  const releasedIds = released.map(row => row.id);
  await client.query("DELETE FROM sector_ownerships WHERE sector_id=ANY($1) AND controller_cid=$2 AND server=$3", [releasedIds, identity.cid, identity.server]);
  await client.query("DELETE FROM sector_requests WHERE sector_id=ANY($1) AND rejected_at IS NULL AND server=$2", [releasedIds, identity.server]);
  await writeDiagnosticLog(client, identity, "ServerSector", `Released ${name}`, {
    action: "release",
    sector: name,
    released: released.map(row => row.name)
  });
  return true;
}

async function transferRequest(client: pg.PoolClient, identity: ControllerIdentity, id: number): Promise<string | null> {
  const result = await client.query(
    `SELECT r.*,s.name FROM sector_requests r JOIN sectors s ON s.id=r.sector_id WHERE r.id=$1 AND r.server=$2 FOR UPDATE`,
    [id, identity.server]);
  const request = result.rows[0];
  if (!request || request.target_cid !== identity.cid) return null;
  const owner = await client.query("SELECT controller_cid FROM sector_ownerships WHERE sector_id=$1 AND server=$2 FOR UPDATE", [request.sector_id, identity.server]);
  if (owner.rows[0]?.controller_cid !== identity.cid) return null;
  // Only what the accepting controller actually holds. A transfer is one controller giving another
  // what they have, and it was instead handing over the requested sector's whole responsible-sectors
  // closure outright - every sector in it, owned by them or not.
  //
  // Two things went wrong with that. A sector a *third* controller owned was silently taken off them
  // by two other people agreeing a handover that had nothing to do with them. And an unowned sector
  // was granted no matter who was logged on as it, which is how Melbourne Approach's sectors kept
  // arriving with Benalla while ML_APP was online and working them: the claim path had already been
  // taught not to take those (see claimGroup's exclusions), but accepting a request bypassed it
  // entirely and put them straight back.
  //
  // Restricting to the giver's own rows fixes both without adding a second opinion about who is
  // online. What is left unowned stays unowned, and is claimed through the ordinary path - which is
  // the one place the staffing rule is applied, and the only place it can be applied correctly.
  // A flow position is given these the same way as anyone - relief cover the holder has just agreed
  // to (see isFlowCallsign). What it may not do is claim them when nobody holds them.
  const rows = (await covered(client, request.name, identity.server))
    .filter(row => row.controller_cid === identity.cid);

  for (const row of rows) {
    await client.query(
      `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at,server)
       VALUES ($1,$2,$3,now(),$4) ON CONFLICT (sector_id, server) DO UPDATE SET controller_cid=$2,
       controller_callsign=$3,last_seen_online_at=now(),updated_at=now()`,
      [row.id, request.requesting_cid, request.requesting_callsign, identity.server]);
  }
  await client.query("DELETE FROM sector_requests WHERE sector_id=ANY($1) AND server=$2", [rows.map(row => row.id), identity.server]);

  // A sector changing hands has to take its aircraft with it. The plugin performs the actual vatSys
  // jurisdiction handoff, but the server has to move the API authority in the same transaction;
  // otherwise the accepting controller's immediate STATE_CONTROLLED push can be rejected because
  // the previous controller is still online somewhere else.
  const transferredFlights = (await client.query(
    `UPDATE flight_data_records SET controlling_cid=$2,controlling_callsign=$3
      WHERE current_sector = ANY($1)
        AND server=$6
        AND controlling_cid=$4
        AND controlling_callsign IS NOT DISTINCT FROM $5
        AND (controlling_cid IS DISTINCT FROM $2 OR controlling_callsign IS DISTINCT FROM $3)
      RETURNING callsign`,
    [rows.map(row => row.name), request.requesting_cid, request.requesting_callsign, identity.cid, identity.callsign, identity.server])).rows.map(row => row.callsign);

  await writeDiagnosticLog(client, identity, "ServerSector", `Accepted request #${id} for ${request.name}`, {
    action: "request_accept",
    request_id: id,
    sector: request.name,
    transferred: rows.map(row => row.name),
    from: { cid: identity.cid, callsign: identity.callsign },
    to: { cid: request.requesting_cid, callsign: request.requesting_callsign },
    fdr_authority_transferred: transferredFlights
  });

  return request.name;
}

export async function sectorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/sectors/sync", async request => syncPayload(pool, request.controller));
  app.get("/sectors/mine", async request => (await syncPayload(pool, request.controller)).mine);
  app.get("/sectors/controlled", async request => (await syncPayload(pool, request.controller)).controlled);
  app.get("/sector-requests", async request => requestsPayload(pool, request.controller));

  app.post<{ Params: { name: string } }>("/sectors/:name/claim", async (request, reply) => {
    const parsed = claimSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(422).send({ message: "Invalid sector claim.", errors: parsed.error.flatten() });
    const result = await transaction(async client => {
      await lockMutations(client, request.controller.server);
      return claimGroup(client, request.controller, request.params.name, parsed.data.exclude, true, parsed.data.primary_group);
    });
    if (result.missing) return reply.code(404).send({ message: "Sector not found." });
    if (result.refused.includes(request.params.name)) return reply.code(403).send({ message: flowOnlyMessage, refused: result.refused });
    if (result.skipped.length) return reply.code(409).send({ message: "Some of these sectors are already owned.", conflicts: result.conflicts });
    return reply.code(201).send(result.claimed);
  });

  app.post<{ Params: { name: string } }>("/sectors/:name/release", async (request, reply) => {
    const released = await transaction(async client => { await lockMutations(client, request.controller.server); return releaseGroup(client, request.controller, request.params.name); });
    return released ? reply.code(204).send() : reply.code(403).send({ message: "Only the current owner may release this sector." });
  });

  // Every route below that runs in a transaction returns its answer *out* of the transaction and
  // sends it afterwards. Two of them used to call reply.send() from inside the callback, which put
  // the response on the wire before COMMIT: the caller was told "done" for something that could
  // still roll back, and the change signal the response triggers could reach other clients before
  // the change it announced was visible to them.
  app.post<{ Params: { name: string } }>("/sectors/:name/request", async (request, reply) => {
    const outcome = await transaction(async (client): Promise<{ code: number; body: unknown }> => {
    await lockMutations(client, request.controller.server);
    const sector = (await client.query(
      `SELECT s.id,s.type,s.callsign,o.controller_cid,o.controller_callsign FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id AND o.server=$2 WHERE s.name=$1`,
      [request.params.name, request.controller.server])).rows[0];
    if (!sector) return { code: 404, body: { message: "Sector not found." } };
    // A flow position may ask for airspace someone holds (relief cover), never claim what nobody does.
    if (!sector.controller_cid && !mayOwn(request.controller, sector)) return { code: 403, body: { message: flowOnlyMessage } };
    if (!sector.controller_cid) return { code: 400, body: { message: "Sector is unclaimed - claim it directly instead of requesting it." } };
    if (sector.controller_cid === request.controller.cid) return { code: 400, body: { message: "You already own this sector." } };
    await client.query("DELETE FROM sector_requests WHERE sector_id=$1 AND requesting_cid=$2 AND server=$3 AND rejected_at IS NOT NULL", [sector.id, request.controller.cid, request.controller.server]);
    const inserted = await client.query(
      `INSERT INTO sector_requests (sector_id,requesting_cid,requesting_callsign,target_cid,target_callsign,server)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sector_id,requesting_cid,server) DO NOTHING RETURNING *`,
      [sector.id, request.controller.cid, request.controller.callsign, sector.controller_cid, sector.controller_callsign, request.controller.server]);
    if (!inserted.rows[0]) return { code: 409, body: { message: "You already have a pending request for this sector." } };
    await writeDiagnosticLog(client, request.controller, "ServerSector", `Requested ${request.params.name} from ${sector.controller_callsign}`, {
      action: "request_create",
      request_id: Number(inserted.rows[0].id),
      sector: request.params.name,
      from: { cid: request.controller.cid, callsign: request.controller.callsign },
      to: { cid: sector.controller_cid, callsign: sector.controller_callsign }
    });
    return { code: 201, body: inserted.rows[0] };
    });
    return reply.code(outcome.code).send(outcome.body);
  });

  app.post("/sectors/commit", async (request, reply) => {
    const parsed = mutationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid sector commit.", errors: parsed.error.flatten() });
    return transaction(async client => {
      await lockMutations(client, request.controller.server);
      // Every request this Apply raises shares one group, so the controller on the other end is
      // asked once about the whole thing rather than once per sector. Requests landing on different
      // targets still share the id harmlessly - each target only ever sees their own rows, so each
      // still gets exactly one decision to make.
      const requestGroupId = randomUUID();
      const result = { claimed: [] as string[], released: [] as string[], requested: [] as string[], skipped: [] as string[], withheld: [] as string[], failed: [] as string[] };
      for (const name of parsed.data.release) (await releaseGroup(client, request.controller, name) ? result.released : result.failed).push(name);
      for (const name of parsed.data.claim) {
        const claimed = await claimGroup(client, request.controller, name, parsed.data.exclude, false, parsed.data.primary_group);
        if (claimed.missing || claimed.refused.includes(name)) result.failed.push(name); else { result.claimed.push(...claimed.claimed); result.skipped.push(...claimed.skipped); result.withheld.push(...claimed.withheld); }
      }
      for (const name of parsed.data.request) {
        const sector = (await client.query(
          `SELECT s.id,s.type,s.callsign,o.controller_cid,o.controller_callsign FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.name=$1 AND o.server=$2`,
          [name, request.controller.server])).rows[0];
        if (!sector || sector.controller_cid === request.controller.cid) { result.failed.push(name); continue; }
        await client.query("DELETE FROM sector_requests WHERE sector_id=$1 AND requesting_cid=$2 AND server=$3 AND rejected_at IS NOT NULL", [sector.id, request.controller.cid, request.controller.server]);
        const inserted = await client.query(
          `INSERT INTO sector_requests (sector_id,requesting_cid,requesting_callsign,target_cid,target_callsign,group_id,server)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (sector_id,requesting_cid,server) DO NOTHING RETURNING id`,
          [sector.id, request.controller.cid, request.controller.callsign, sector.controller_cid, sector.controller_callsign, requestGroupId, request.controller.server]);
        (inserted.rows[0] ? result.requested : result.failed).push(name);
      }
      await writeDiagnosticLog(client, request.controller, "ServerSector", "Committed sector changes", {
        action: "commit",
        group_id: requestGroupId,
        requested_input: parsed.data.request,
        claim_input: parsed.data.claim,
        release_input: parsed.data.release,
        exclusions: parsed.data.exclude,
        ...result
      });
      return { result, sync: await syncPayload(client, request.controller) };
    });
  });

  app.post("/sectors/release-all", async (request, reply) => {
    await transaction(async client => {
    await lockMutations(client, request.controller.server);
    const sectors = (await client.query(
      `SELECT s.name FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
       WHERE o.controller_cid=$1 AND o.controller_callsign=$2 AND o.server=$3`,
      [request.controller.cid, request.controller.callsign, request.controller.server])).rows.map(row => row.name);
    const flights = (await client.query(
      "SELECT callsign FROM flight_data_records WHERE controlling_cid=$1 AND controlling_callsign=$2 AND server=$3",
      [request.controller.cid, request.controller.callsign, request.controller.server])).rows.map(row => row.callsign);
    await client.query(
      `INSERT INTO resume_snapshots (controller_cid,controller_callsign,sectors,flights,created_at,server) VALUES ($1,$2,$3,$4,now(),$5)
       ON CONFLICT (controller_cid,controller_callsign,server) DO UPDATE SET sectors=$3,flights=$4,created_at=now()`,
      [request.controller.cid, request.controller.callsign, JSON.stringify(sectors), JSON.stringify(flights), request.controller.server]);
    const freed = (await client.query(
      "DELETE FROM sector_ownerships WHERE controller_cid=$1 AND controller_callsign=$2 AND server=$3 RETURNING sector_id",
      [request.controller.cid, request.controller.callsign, request.controller.server])).rows.map(row => row.sector_id);
    // Deliberately here and in the disconnect sweep, but NOT in releaseGroup. Those two are the
    // controller leaving; releaseGroup is a deliberate release while still connected, and doing it
    // there would bounce a sub-sector straight back to anyone who also holds its parent, making it
    // impossible to free one by hand.
    await reassignFreedSectors(client, freed, request.controller.server);
    await client.query("DELETE FROM sector_requests WHERE (requesting_cid=$1 OR target_cid=$1) AND server=$2", [request.controller.cid, request.controller.server]);
    const transferredFlights = await transferFlightsToCurrentSectorOwners(client, request.controller);
    const clearedFlights = await clearFlightsWithoutCurrentSectorOwner(client, request.controller);
    await writeDiagnosticLog(client, request.controller, "ServerSector", "Released all sectors", {
      action: "release_all",
      sectors,
      sector_ids: freed,
      fdr_authority_transferred: transferredFlights,
      fdr_authority_cleared: clearedFlights
    });
    });
    return reply.code(204).send();
  });

  app.post("/sectors/resume", async request => transaction(async client => {
    await lockMutations(client, request.controller.server);

    // What this controller still holds under a *different* callsign, from a session that has gone
    // quiet. Ownership is decided by cid alone (claimGroup, releaseGroup, /sectors/sync's `mine`)
    // but kept alive and released by cid and callsign together (the heartbeat, release-all, the
    // sweep), so a controller who dropped and came back as another position was left "owning" the
    // old position's sectors under a callsign nobody was connected as: listed as theirs, never
    // heartbeated, untouched by their own release-all, and read by claimGroup as a controller
    // logged on to a position they had left - until the sweep finally removed them minutes later.
    // Coming back as someone else is the end of that session, so it is closed here the way the
    // sweep would close it. Only rows already past the presence window: a second client genuinely
    // connected under the same cid (a SweatBox mentor running two positions) is still heartbeating
    // its own, and is left alone. Never straight after a restart, when every row looks stale.
    const superseded = isWithinStartupGrace(config.PRESENCE_TIMEOUT_SECONDS * 1000) ? [] : (await client.query<{ sector_id: string; controller_callsign: string }>(
      `DELETE FROM sector_ownerships
        WHERE controller_cid=$1 AND server=$2 AND controller_callsign<>$3
          AND last_seen_online_at < now()-($4*interval '1 second')
        RETURNING sector_id,controller_callsign`,
      [request.controller.cid, request.controller.server, request.controller.callsign, config.PRESENCE_TIMEOUT_SECONDS])).rows;
    if (superseded.length > 0) {
      const previousCallsigns = [...new Set(superseded.map(row => row.controller_callsign))];
      await reassignFreedSectors(client, superseded.map(row => row.sector_id), request.controller.server);
      for (const callsign of previousCallsigns) {
        const previous = { cid: request.controller.cid, callsign, server: request.controller.server };
        await transferFlightsToCurrentSectorOwners(client, previous);
        await clearFlightsWithoutCurrentSectorOwner(client, previous);
      }
      await writeDiagnosticLog(client, request.controller, "ServerSector", "Closed a previous session under another callsign", {
        action: "resume_superseded_session",
        previous_callsigns: previousCallsigns,
        sector_ids: superseded.map(row => row.sector_id)
      });
    }
    const snapshot = (await client.query(
      "DELETE FROM resume_snapshots WHERE controller_cid=$1 AND controller_callsign=$2 AND server=$3 RETURNING *",
      [request.controller.cid, request.controller.callsign, request.controller.server])).rows[0];
    const resumed: string[] = [];
    const restoredFlights: string[] = [];
    if (snapshot && Date.now() - new Date(snapshot.created_at).getTime() <= config.RESUME_WINDOW_MINUTES * 60_000) {
      for (const name of snapshot.sectors as string[]) {
        const sector = (await client.query("SELECT id FROM sectors WHERE name=$1", [name])).rows[0];
        if (!sector) continue;
        const inserted = await client.query(
          `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at,server)
           VALUES ($1,$2,$3,now(),$4) ON CONFLICT (sector_id,server) DO NOTHING RETURNING sector_id`,
          [sector.id, request.controller.cid, request.controller.callsign, request.controller.server]);
        if (inserted.rows[0]) resumed.push(name);
      }
      // The WHERE is what keeps this honest: a flight another controller picked up while this one
      // was away is left with them. RETURNING reports only what was actually restored, so the
      // client can bring exactly those tags straight back instead of flashing every one it used to
      // hold and hoping.
      // Three conditions, and all of them matter.
      //
      // The controlling_cid test keeps this honest about other controllers: a flight someone else
      // picked up while this one was away stays with them.
      //
      // The current_sector test keeps it honest about geography. An aircraft that has flown out of
      // this controller's airspace since they dropped is in someone else's sector now, and handing
      // it back would put their name on a tag they cannot work - on the map, in /fdr/sync, and in
      // the plugin's own pickup logic. Restricted to sectors they hold *after* the resume above, so
      // a sector claimed by someone else in the meantime takes its aircraft with it. A flight whose
      // current_sector is NULL is not matched by IN either, which is the right default: an aircraft
      // that has not resolved into any known sector is not one to silently reassign.
      // Re-attach the tags this controller gave up. The controlling_cid test leaves a flight
      // another controller picked up with them; the current_sector test leaves one that has flown
      // out of the airspace they just took back.
      await client.query(
        `UPDATE flight_data_records SET controlling_cid=$1,controlling_callsign=$2
          WHERE callsign=ANY($3)
            AND server=$4
            AND controlling_cid IS NULL
            AND current_sector IN (
                  SELECT s.name FROM sectors s
                    JOIN sector_ownerships o ON o.sector_id=s.id
                   WHERE o.controller_cid=$1 AND o.server=$4)`,
        [request.controller.cid, request.controller.callsign, snapshot.flights, request.controller.server]);
    }

    // Answered for BOTH kinds of reconnect, which is why it is outside the snapshot branch.
    //
    // A graceful disconnect wrote a snapshot and gave the sectors and tags up, so the block above
    // has to put them back before this can see them.
    //
    // An ungraceful one - client closed, connection dropped - wrote nothing and gave nothing up.
    // The ownership rows and the tag authority are still this controller's until the grace sweep
    // takes them, so there is nothing to restore. But vatSys has come back with no jurisdiction at
    // all, so the client still has to be *told* which tags are already its own, or it will offer
    // the controller their own tags as incoming handovers - which is exactly what it was doing.
    //
    // One query serves both: every flight this controller now holds, inside a sector they now hold.
    restoredFlights.push(...(await client.query(
      `SELECT callsign FROM flight_data_records
        WHERE controlling_cid=$1
          AND server=$2
          AND current_sector IN (
                SELECT s.name FROM sectors s
                  JOIN sector_ownerships o ON o.sector_id=s.id
                 WHERE o.controller_cid=$1 AND o.server=$2)
        ORDER BY callsign`,
      [request.controller.cid, request.controller.server])).rows.map(row => row.callsign));

    await writeDiagnosticLog(client, request.controller, "ServerSector", "Resume processed", {
      action: "resume",
      had_snapshot: Boolean(snapshot),
      resumed,
      restored_flights: restoredFlights
    });

    return { resumed, flights: restoredFlights, sync: await syncPayload(client, request.controller) };
  }));

  app.post<{ Params: { id: string } }>("/sector-requests/:id/accept", async (request, reply) => {
    const id = requestIdSchema.safeParse(request.params.id);
    const sync = !id.success ? null : await transaction(async client => {
      await lockMutations(client, request.controller.server);
      const sector = await transferRequest(client, request.controller, id.data);
      return sector ? syncPayload(client, request.controller) : null;
    });
    return sync ? { message: "Ownership transferred.", sync }
      : reply.code(403).send({ message: "Only the sector's current owner may accept this request." });
  });

  app.post("/sector-requests/accept-batch", async (request, reply) => {
    const parsed = requestIdsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(422).send({ message: "Invalid request ids.", errors: parsed.error.flatten() });
    return transaction(async client => {
    await lockMutations(client, request.controller.server);
    // Read up front, because accepting one request deletes the others its transfer carried along:
    // accepting BLA moves ELW and MAE with it (transferRequest walks the whole covered group), and
    // their own requests in the same batch then no longer exist. That is not a failure - the sector
    // went exactly where it was asked to - and reporting it as one put "Request no longer exists"
    // in front of a controller who had just accepted the lot.
    const pending = new Map((await client.query(
      `SELECT r.id, r.requesting_cid, s.name FROM sector_requests r JOIN sectors s ON s.id=r.sector_id
        WHERE r.id=ANY($1) AND r.target_cid=$2 AND r.server=$3`,
      [parsed.data.request_ids, request.controller.cid, request.controller.server])).rows
      .map(row => [Number(row.id), { requestingCid: Number(row.requesting_cid), name: String(row.name) }]));
    const results = [];
    for (const id of parsed.data.request_ids) {
      const sector = await transferRequest(client, request.controller, id);
      if (sector) {
        results.push({ request_id: id, sector, accepted: true, message: "Ownership transferred." });
        continue;
      }
      const before = pending.get(id);
      const carried = before && (await client.query(
        `SELECT 1 FROM sector_ownerships o JOIN sectors s ON s.id=o.sector_id
          WHERE s.name=$1 AND o.controller_cid=$2 AND o.server=$3`,
        [before.name, before.requestingCid, request.controller.server])).rowCount;
      results.push(carried
        ? { request_id: id, sector: before!.name, accepted: true, message: "Transferred with another sector in this request." }
        : { request_id: id, sector: null, accepted: false, message: "Request no longer exists or is not yours to accept." });
    }
    return { results, sync: await syncPayload(client, request.controller) };
    });
  });

  // Mirrors accept-batch so declining a grouped request is one call rather than one per sector.
  app.post("/sector-requests/reject-batch", async (request, reply) => {
    const parsed = requestIdsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(422).send({ message: "Invalid request ids.", errors: parsed.error.flatten() });
    const ids = parsed.data.request_ids;
    const changed = await pool.query(
      "UPDATE sector_requests SET rejected_at=now() WHERE id=ANY($1) AND target_cid=$2 AND server=$3 AND rejected_at IS NULL RETURNING id",
      [ids, request.controller.cid, request.controller.server]);
    await writeDiagnosticLog(pool, request.controller, "ServerSector", "Rejected request batch", {
      action: "request_reject_batch",
      request_ids: ids.map(String),
      rejected: changed.rows.map(row => Number(row.id))
    });
    return { rejected: changed.rows.map(row => Number(row.id)), sync: await syncPayload(pool, request.controller) };
  });

  app.post<{ Params: { id: string } }>("/sector-requests/:id/reject", async (request, reply) => {
    if (!requestIdSchema.safeParse(request.params.id).success) return reply.code(403).send({ message: "This request cannot be rejected." });
    const changed = await pool.query(
      "UPDATE sector_requests SET rejected_at=now() WHERE id=$1 AND target_cid=$2 AND server=$3 AND rejected_at IS NULL RETURNING id",
      [request.params.id, request.controller.cid, request.controller.server]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Rejected request #${request.params.id}`, {
        action: "request_reject",
        request_id: request.params.id
      });
    return changed.rowCount ? { message: "Request rejected.", sync: await syncPayload(pool, request.controller) } : reply.code(403).send({ message: "This request cannot be rejected." });
  });
  app.post<{ Params: { id: string } }>("/sector-requests/:id/cancel", async (request, reply) => {
    if (!requestIdSchema.safeParse(request.params.id).success) return reply.code(403).send({ message: "This request cannot be cancelled." });
    const changed = await pool.query(
      "DELETE FROM sector_requests WHERE id=$1 AND requesting_cid=$2 AND server=$3 RETURNING id",
      [request.params.id, request.controller.cid, request.controller.server]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Cancelled request #${request.params.id}`, {
        action: "request_cancel",
        request_id: request.params.id
      });
    return changed.rowCount ? { message: "Request cancelled.", sync: await syncPayload(pool, request.controller) } : reply.code(403).send({ message: "This request cannot be cancelled." });
  });
  app.post<{ Params: { id: string } }>("/sector-requests/:id/acknowledge-rejection", async (request, reply) => {
    if (!requestIdSchema.safeParse(request.params.id).success) return reply.code(404).send({ message: "Rejected request not found." });
    const changed = await pool.query(
      "DELETE FROM sector_requests WHERE id=$1 AND requesting_cid=$2 AND server=$3 AND rejected_at IS NOT NULL RETURNING id",
      [request.params.id, request.controller.cid, request.controller.server]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Acknowledged rejected request #${request.params.id}`, {
        action: "request_acknowledge_rejection",
        request_id: request.params.id
      });
    return changed.rowCount ? reply.code(204).send() : reply.code(404).send({ message: "Rejected request not found." });
  });
}
