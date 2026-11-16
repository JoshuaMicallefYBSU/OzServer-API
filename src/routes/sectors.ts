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

// Flow (FMP) positions claim flow sectors and nothing else: an FMP controller transmits on enroute
// and TMA lines to talk to those units, and must not come to own their sectors by doing so. It may
// still request a sector another controller holds, as relief cover. The plugin applies the same
// rule (PrimaryPosition.MayOwn). A sector's type is its callsign suffix (see sync-dataset).
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
  // Accepted and ignored - see claimGroup.
  primary_group: sectorNames.optional()
});

// The single-sector claim's body. A plain claim sends nothing but its identity.
const claimSchema = z.object({
  exclude: sectorNames.default([]),
  primary_group: sectorNames.optional()
});

// Validated here so a malformed id is answered as a client error, not as a 500 from a type error
// inside a query.
const requestIdSchema = z.coerce.number().int().positive();
const requestIdsSchema = z.object({ request_ids: z.array(requestIdSchema).max(400).default([]) });

async function lockMutations(client: pg.PoolClient, server: string): Promise<void> {
  // Sector groups overlap, so one transaction-wide advisory lock makes each check-and-write atomic,
  // including claims that expand to responsible sectors and batch commits. Keyed per server: live
  // and sweatbox mutations touch disjoint rows and need not wait on each other.
  await client.query("SELECT pg_advisory_xact_lock(684276, hashtext($1))", [server]);
}

// Bounded like the plugin's own tree recursion (PrimaryPosition.MaxDepth), against a cyclical
// grouping in the dataset.
const MAX_GROUP_DEPTH = 8;

// Everything claiming `name` covers: the sector itself plus its responsible sectors, all the way
// down - groups nest, and the plugin's PrimaryPosition expands them the same way.
//
// `sectors` is shared across every server (see migrations/006_server_isolation.sql), so only the
// ownership join is scoped to `server` - in the join condition, since a WHERE filter would drop a
// sector nobody has claimed on this server instead of returning it with a null owner.
async function covered(client: pg.PoolClient, name: string, server: string): Promise<SectorRow[]> {
  const primary = await client.query<SectorRow>(
    `SELECT s.*, o.controller_cid, o.controller_callsign, o.last_seen_online_at
       FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id AND o.server=$2 WHERE s.name=$1`,
    [name, server]);
  const sector = primary.rows[0];
  if (!sector) return [];

  // Seeded with the sector's own name: a sector that is both directly controllable and a group
  // lists itself among its own responsible sectors, and must not be expanded again.
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

// Whether this row's owner is still connected, for deciding whether a different controller may
// claim their sector outright. Measured in PRESENCE_TIMEOUT_SECONDS, not DISCONNECT_GRACE_MINUTES:
// a dropped connection must not keep a sector locked until the sweep releases it.
function isPresent(row: SectorRow): boolean {
  // Just after a restart every row looks stale, so the owner is assumed present (see presence.ts
  // for why the window passed is this check's own threshold).
  if (isWithinStartupGrace(config.PRESENCE_TIMEOUT_SECONDS * 1000)) return true;
  return row.last_seen_online_at !== null
    && Date.now() - new Date(row.last_seen_online_at).getTime() < config.PRESENCE_TIMEOUT_SECONDS * 1000;
}

// Claims `name` and everything it covers for `identity`.
//
// `exclusions` are left out of the expansion entirely - not taken, not conflict-checked, not
// reported. A client retrying after a 409 carves out what somebody else owns, and every claim
// carves out the covered sectors somebody is logged on as (PrimaryPosition.StaffedCoveredSectors),
// which stops an enroute controller taking an approach controller's sectors top-down.
//
// The server does not depend on those exclusions being complete: a covered sector whose present
// owner is logged on to a position inside the claim is "withheld" rather than conflicted, so an
// enroute controller logging on over an online APP/TCU gets the uncontested sectors and no 409.
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
  // (a client's retry after a 409 that contested everything) names a real sector and is not a 404.
  if (everything.length === 0) return { claimed: [], skipped: [], withheld: [], conflicts: [], missing: true, refused: [] };
  // Sectors this controller may never hold (see isFlowCallsign). Not conflicts (there is nobody to
  // ask) and not withheld (they will not become claimable later).
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
  // Worked out before the exclusions are applied. The client excludes a logged-on controller's
  // position as it understands it, which is not always everything this server records them
  // holding in the group; computed afterwards, the staffed sector itself would be gone and their
  // remaining sectors would come back as conflicts instead of being withheld.
  const positionOwnersInClaim = new Set(everything
    .filter(row => row.controller_callsign
      && row.callsign?.toUpperCase() === row.controller_callsign.toUpperCase())
    .map(row => row.controller_callsign!.toUpperCase()));
  // No claim takes a sector off a controller who is present - not even a primary logging on to
  // their own position, since the aircraft inside would move with it mid-session. A present owner
  // is always a conflict, which the arriving client turns into a request to the holder
  // (OzServerOwnershipTracker.HandleConflictAsync). primary_group is therefore accepted from
  // clients that send it, and ignored.
  void primaryGroup;

  for (const row of rows) {
    if (row.controller_cid === null || row.controller_cid === identity.cid) {
      takeable.push(row);
      continue;
    }
    const ownerHasPositionInThisClaim = positionOwnersInClaim.has(row.controller_callsign?.toUpperCase() ?? "");
    // An owner who is not present does not block the claim: a dropped connection is not a
    // reservation (see isPresent).
    if (isPresent(row)) {
      // Withholding is for what a claim merely sweeps up. The sector the claim names is a conflict
      // like any other: answering 201 with it left out would read as success, and the client would
      // claim it again on every poll without a request ever being raised.
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
  // hands names a target who no longer owns it: nobody can accept it (transferRequest checks both)
  // and the requester cannot ask again (one request per sector). The claimant's own request for a
  // sector they now hold is moot.
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
  // Only what the accepting controller holds, not the requested sector's whole closure: that would
  // take a third controller's sector off them, and grant an unowned sector regardless of who is
  // logged on as it. What is left unowned is claimed through the ordinary path, where the staffing
  // rule applies. A flow position is given sectors this way like anyone else (see isFlowCallsign).
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

  // A sector changing hands takes its aircraft with it. The plugin performs the vatSys jurisdiction
  // handoff, but API authority has to move in the same transaction; otherwise the new owner's
  // immediate STATE_CONTROLLED push can be rejected while the previous controller is still online.
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

  // Every route below that runs in a transaction returns its answer out of the transaction and
  // sends it afterwards: reply.send() inside the callback would put the response, and the change
  // signal it triggers, on the wire before COMMIT.
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
      // Every request this commit raises shares one group id, so the controller on the other end is
      // asked once about the whole thing rather than once per sector.
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
    // Here and in the disconnect sweep (the controller leaving), but deliberately not in
    // releaseGroup: reassigning on a release while still connected would bounce a sub-sector
    // straight back to anyone who also holds its parent, making it impossible to free one by hand.
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

    // Closes a session this controller left under a different callsign. Ownership is decided by cid
    // alone (claimGroup, releaseGroup, sync's `mine`) but kept alive and released by cid and
    // callsign together (the heartbeat, release-all, the sweep), so a controller who came back as
    // another position would otherwise keep the old position's sectors, never heartbeated, until
    // the sweep. Only rows past the presence window: a second client under the same cid (a
    // SweatBox mentor running two positions) is still heartbeating its own. Skipped straight after
    // a restart, when every row looks stale.
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
      // Re-attach the tags this controller gave up. The controlling_cid test leaves a flight
      // another controller picked up with them; the current_sector test leaves one that is no
      // longer in a sector this controller holds after the resume above, or is in no known sector.
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

    // Outside the snapshot branch because it answers both kinds of reconnect. An ungraceful
    // disconnect wrote no snapshot and gave nothing up, so there is nothing to restore - but vatSys
    // comes back with no jurisdiction, and the client must be told which tags are already its own
    // or it will offer them to the controller as incoming handovers.
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
    // Read up front, because accepting one request deletes the others its transfer carries along
    // (a group's sub-sectors move with it). Those are reported as accepted, not as failures.
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
    // The parsed number goes to Postgres, not the raw parameter: "1e2" coerces to a valid id here
    // but is not a value a bigint column accepts.
    const id = requestIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(403).send({ message: "This request cannot be rejected." });
    const changed = await pool.query(
      "UPDATE sector_requests SET rejected_at=now() WHERE id=$1 AND target_cid=$2 AND server=$3 AND rejected_at IS NULL RETURNING id",
      [id.data, request.controller.cid, request.controller.server]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Rejected request #${id.data}`, {
        action: "request_reject",
        request_id: id.data
      });
    return changed.rowCount ? { message: "Request rejected.", sync: await syncPayload(pool, request.controller) } : reply.code(403).send({ message: "This request cannot be rejected." });
  });
  app.post<{ Params: { id: string } }>("/sector-requests/:id/cancel", async (request, reply) => {
    const id = requestIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(403).send({ message: "This request cannot be cancelled." });
    const changed = await pool.query(
      "DELETE FROM sector_requests WHERE id=$1 AND requesting_cid=$2 AND server=$3 RETURNING id",
      [id.data, request.controller.cid, request.controller.server]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Cancelled request #${id.data}`, {
        action: "request_cancel",
        request_id: id.data
      });
    return changed.rowCount ? { message: "Request cancelled.", sync: await syncPayload(pool, request.controller) } : reply.code(403).send({ message: "This request cannot be cancelled." });
  });
  app.post<{ Params: { id: string } }>("/sector-requests/:id/acknowledge-rejection", async (request, reply) => {
    const id = requestIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(404).send({ message: "Rejected request not found." });
    const changed = await pool.query(
      "DELETE FROM sector_requests WHERE id=$1 AND requesting_cid=$2 AND server=$3 AND rejected_at IS NOT NULL RETURNING id",
      [id.data, request.controller.cid, request.controller.server]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Acknowledged rejected request #${id.data}`, {
        action: "request_acknowledge_rejection",
        request_id: id.data
      });
    return changed.rowCount ? reply.code(204).send() : reply.code(404).send({ message: "Rejected request not found." });
  });
}
