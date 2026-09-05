import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { config } from "../config.js";
import { writeDiagnosticLog } from "../diagnostics.js";
import { pool, transaction } from "../db.js";
import { reassignFreedSectors } from "../grouping.js";
import type { ControllerIdentity } from "../types.js";
import { onlineControllers } from "../vatsim.js";

type SectorRow = {
  id: string; name: string; full_name: string; callsign: string | null;
  responsible_sectors: string[]; controller_cid: number | null;
  controller_callsign: string | null; last_seen_online_at: Date | null;
};

const mutationSchema = z.object({
  claim: z.array(z.string()).default([]),
  release: z.array(z.string()).default([]),
  request: z.array(z.string()).default([]),
  // Applied to every sector in `claim` - see claimGroup's `exclusions`.
  exclude: z.array(z.string()).default([])
});

async function lockMutations(client: pg.PoolClient): Promise<void> {
  // Sector groups overlap. One transaction-wide lock makes the complete check-and-write operation
  // atomic, including claims involving responsible sectors and batch commits.
  await client.query("SELECT pg_advisory_xact_lock(684276)");
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
async function covered(client: pg.PoolClient, name: string): Promise<SectorRow[]> {
  const primary = await client.query<SectorRow>(
    `SELECT s.*, o.controller_cid, o.controller_callsign, o.last_seen_online_at
       FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.name=$1`, [name]);
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
       FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.name = ANY($1)`,
    [[...names]])).rows;
}

function isWithinGrace(row: SectorRow): boolean {
  return row.last_seen_online_at !== null
    && Date.now() - new Date(row.last_seen_online_at).getTime() < config.DISCONNECT_GRACE_MINUTES * 60_000;
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
// as "withheld", not conflicted. That protects against stale or incomplete client exclusions: an
// enroute controller logging on over an already-online APP/TCU keeps the uncontested ENR sectors,
// the APP/TCU keeps its sectors, and the client does not receive a 409 that would create a request
// popup/error.
async function claimGroup(
  client: pg.PoolClient,
  identity: ControllerIdentity,
  name: string,
  online: Map<string, number> | null,
  exclusions: string[] = [],
  allOrNothing = false
): Promise<{ claimed: string[]; skipped: string[]; withheld: string[]; conflicts: Array<{ sector: string; owner: { cid: number; callsign: string } }>; missing: boolean }> {
  const rows = (await covered(client, name)).filter(row => !exclusions.includes(row.name));
  if (rows.length === 0) return { claimed: [], skipped: [], withheld: [], conflicts: [], missing: true };
  const takeable: SectorRow[] = [];
  const skipped: string[] = [];
  const withheld: string[] = [];
  const conflicts: Array<{ sector: string; owner: { cid: number; callsign: string } }> = [];
  const primary = rows.find(row => row.name === name);
  const claimantIsNamedPrimary = primary?.callsign?.toUpperCase() === identity.callsign.toUpperCase();
  const positionOwnersInClaim = new Set(rows
    .filter(row => row.controller_callsign
      && row.callsign?.toUpperCase() === row.controller_callsign.toUpperCase())
    .map(row => row.controller_callsign!.toUpperCase()));
  const overriddenTopDown: Array<{ sector: string; owner: { cid: number; callsign: string } }> = [];

  for (const row of rows) {
    if (row.controller_cid === null || row.controller_cid === identity.cid
      || row.callsign?.toUpperCase() === identity.callsign.toUpperCase()) {
      takeable.push(row);
      continue;
    }
    const ownerIsLoggedOnForThisSector = row.callsign?.toUpperCase() === row.controller_callsign?.toUpperCase();
    const ownerHasPositionInThisClaim = positionOwnersInClaim.has(row.controller_callsign?.toUpperCase() ?? "");
    if (claimantIsNamedPrimary && !ownerIsLoggedOnForThisSector && !ownerHasPositionInThisClaim) {
      takeable.push(row);
      overriddenTopDown.push({ sector: row.name, owner: { cid: row.controller_cid, callsign: row.controller_callsign ?? "" } });
      continue;
    }
    const ownerOnline = online?.get(row.controller_callsign?.toUpperCase() ?? "") === row.controller_cid;
    if (ownerOnline || isWithinGrace(row)) {
      if (ownerHasPositionInThisClaim) {
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
      overridden_top_down: overriddenTopDown,
      all_or_nothing: allOrNothing
    });
    return { claimed: [], skipped, withheld, conflicts, missing: false };
  }

  const previousOwners = takeable
    .filter(row => row.controller_cid !== null && row.controller_cid !== identity.cid)
    .map(row => ({ sector: row.name, cid: row.controller_cid, callsign: row.controller_callsign }));

  for (const row of takeable) {
    await client.query(
      `INSERT INTO sector_ownerships (sector_id, controller_cid, controller_callsign, last_seen_online_at)
       VALUES ($1,$2,$3,now()) ON CONFLICT (sector_id) DO UPDATE SET
       controller_cid=excluded.controller_cid, controller_callsign=excluded.controller_callsign,
       last_seen_online_at=now(), updated_at=now()`, [row.id, identity.cid, identity.callsign]);
  }

  if (takeable.length > 0 || skipped.length > 0 || withheld.length > 0 || exclusions.length > 0) {
    await writeDiagnosticLog(client, identity, "ServerSector", `Claim ${name}: ${takeable.length} claimed, ${skipped.length} skipped, ${withheld.length} withheld`, {
      action: "claim",
      sector: name,
      claimed: takeable.map(row => row.name),
      skipped,
      withheld,
      conflicts,
      exclusions,
      overridden_top_down: overriddenTopDown,
      previous_owners: previousOwners,
      all_or_nothing: allOrNothing
    });
  }

  return { claimed: takeable.map(row => row.name), skipped, withheld, conflicts, missing: false };
}

async function requestsPayload(client: pg.Pool | pg.PoolClient, identity: ControllerIdentity) {
  const rows = (await client.query(
    `SELECT r.*, s.name AS sector_name, s.full_name AS sector_full_name
       FROM sector_requests r JOIN sectors s ON s.id=r.sector_id
      WHERE r.requesting_cid=$1 OR r.target_cid=$1 ORDER BY r.created_at`, [identity.cid])).rows;
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
      WHERE o.controller_cid=$1 ORDER BY s.name`, [identity.cid])).rows.map(row => ({ ...row, id: Number(row.id) }));
  const controlled = (await client.query(
    `SELECT s.name,s.full_name,s.type,s.callsign,s.frequency,o.controller_cid AS cid,o.controller_callsign AS owner_callsign
       FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
      WHERE o.controller_cid<>$1 ORDER BY s.name`, [identity.cid])).rows.map(row => ({
        name: row.name, full_name: row.full_name, type: row.type, callsign: row.callsign,
        frequency: row.frequency, owner: { cid: row.cid, callsign: row.owner_callsign }
      }));
  return { mine, controlled, requests: await requestsPayload(client, identity) };
}

async function releaseGroup(client: pg.PoolClient, identity: ControllerIdentity, name: string): Promise<boolean> {
  const rows = await covered(client, name);
  const primary = rows.find(row => row.name === name);
  if (!primary || primary.controller_cid !== identity.cid) return false;
  const ids = rows.map(row => row.id);
  await client.query("DELETE FROM sector_ownerships WHERE sector_id=ANY($1) AND controller_cid=$2", [ids, identity.cid]);
  await client.query("DELETE FROM sector_requests WHERE sector_id=$1 AND rejected_at IS NULL", [primary.id]);
  await writeDiagnosticLog(client, identity, "ServerSector", `Released ${name}`, {
    action: "release",
    sector: name,
    released: rows.filter(row => row.controller_cid === identity.cid).map(row => row.name)
  });
  return true;
}

async function transferRequest(client: pg.PoolClient, identity: ControllerIdentity, id: number): Promise<string | null> {
  const result = await client.query(
    `SELECT r.*,s.name FROM sector_requests r JOIN sectors s ON s.id=r.sector_id WHERE r.id=$1 FOR UPDATE`, [id]);
  const request = result.rows[0];
  if (!request || request.target_cid !== identity.cid) return null;
  const owner = await client.query("SELECT controller_cid FROM sector_ownerships WHERE sector_id=$1 FOR UPDATE", [request.sector_id]);
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
  const rows = (await covered(client, request.name))
    .filter(row => row.controller_cid === identity.cid);

  for (const row of rows) {
    await client.query(
      `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at)
       VALUES ($1,$2,$3,now()) ON CONFLICT (sector_id) DO UPDATE SET controller_cid=$2,
       controller_callsign=$3,last_seen_online_at=now(),updated_at=now()`,
      [row.id, request.requesting_cid, request.requesting_callsign]);
  }
  await client.query("DELETE FROM sector_requests WHERE sector_id=ANY($1)", [rows.map(row => row.id)]);

  // A sector changing hands has to take its aircraft with it. The plugin performs the actual vatSys
  // jurisdiction handoff, but the server has to move the API authority in the same transaction;
  // otherwise the accepting controller's immediate STATE_CONTROLLED push can be rejected because
  // the previous controller is still online somewhere else.
  const transferredFlights = (await client.query(
    `UPDATE flight_data_records SET controlling_cid=$2,controlling_callsign=$3
      WHERE current_sector = ANY($1) AND controlling_cid IS NOT NULL AND controlling_cid <> $2
      RETURNING callsign`,
    [rows.map(row => row.name), request.requesting_cid, request.requesting_callsign])).rows.map(row => row.callsign);

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

  app.post<{ Params: { name: string }; Body: { exclude?: string[] } }>("/sectors/:name/claim", async (request, reply) => {
    const result = await transaction(async client => {
      await lockMutations(client);
      return claimGroup(client, request.controller, request.params.name, await onlineControllers(), request.body?.exclude ?? [], true);
    });
    if (result.missing) return reply.code(404).send({ message: "Sector not found." });
    if (result.skipped.length) return reply.code(409).send({ message: "Some of these sectors are already owned.", conflicts: result.conflicts });
    return reply.code(201).send(result.claimed);
  });

  app.post<{ Params: { name: string } }>("/sectors/:name/release", async (request, reply) => {
    const released = await transaction(async client => { await lockMutations(client); return releaseGroup(client, request.controller, request.params.name); });
    return released ? reply.code(204).send() : reply.code(403).send({ message: "Only the current owner may release this sector." });
  });

  app.post<{ Params: { name: string } }>("/sectors/:name/request", async (request, reply) => transaction(async client => {
    await lockMutations(client);
    const sector = (await client.query(
      `SELECT s.id,o.controller_cid,o.controller_callsign FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.name=$1`,
      [request.params.name])).rows[0];
    if (!sector) return reply.code(404).send({ message: "Sector not found." });
    if (!sector.controller_cid) return reply.code(400).send({ message: "Sector is unclaimed - claim it directly instead of requesting it." });
    if (sector.controller_cid === request.controller.cid) return reply.code(400).send({ message: "You already own this sector." });
    await client.query("DELETE FROM sector_requests WHERE sector_id=$1 AND requesting_cid=$2 AND rejected_at IS NOT NULL", [sector.id, request.controller.cid]);
    const inserted = await client.query(
      `INSERT INTO sector_requests (sector_id,requesting_cid,requesting_callsign,target_cid,target_callsign)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sector_id,requesting_cid) DO NOTHING RETURNING *`,
      [sector.id, request.controller.cid, request.controller.callsign, sector.controller_cid, sector.controller_callsign]);
    if (!inserted.rows[0]) return reply.code(409).send({ message: "You already have a pending request for this sector." });
    await writeDiagnosticLog(client, request.controller, "ServerSector", `Requested ${request.params.name} from ${sector.controller_callsign}`, {
      action: "request_create",
      request_id: Number(inserted.rows[0].id),
      sector: request.params.name,
      from: { cid: request.controller.cid, callsign: request.controller.callsign },
      to: { cid: sector.controller_cid, callsign: sector.controller_callsign }
    });
    return reply.code(201).send(inserted.rows[0]);
  }));

  app.post("/sectors/commit", async (request, reply) => {
    const parsed = mutationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid sector commit.", errors: parsed.error.flatten() });
    return transaction(async client => {
      await lockMutations(client);
      // Every request this Apply raises shares one group, so the controller on the other end is
      // asked once about the whole thing rather than once per sector. Requests landing on different
      // targets still share the id harmlessly - each target only ever sees their own rows, so each
      // still gets exactly one decision to make.
      const requestGroupId = randomUUID();
      const result = { claimed: [] as string[], released: [] as string[], requested: [] as string[], skipped: [] as string[], withheld: [] as string[], failed: [] as string[] };
      for (const name of parsed.data.release) (await releaseGroup(client, request.controller, name) ? result.released : result.failed).push(name);
      const online = await onlineControllers();
      for (const name of parsed.data.claim) {
        const claimed = await claimGroup(client, request.controller, name, online, parsed.data.exclude);
        if (claimed.missing) result.failed.push(name); else { result.claimed.push(...claimed.claimed); result.skipped.push(...claimed.skipped); result.withheld.push(...claimed.withheld); }
      }
      for (const name of parsed.data.request) {
        const sector = (await client.query(
          `SELECT s.id,o.controller_cid,o.controller_callsign FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.name=$1`, [name])).rows[0];
        if (!sector || sector.controller_cid === request.controller.cid) { result.failed.push(name); continue; }
        await client.query("DELETE FROM sector_requests WHERE sector_id=$1 AND requesting_cid=$2 AND rejected_at IS NOT NULL", [sector.id, request.controller.cid]);
        await client.query(
          `INSERT INTO sector_requests (sector_id,requesting_cid,requesting_callsign,target_cid,target_callsign,group_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sector_id,requesting_cid) DO NOTHING RETURNING id`,
          [sector.id, request.controller.cid, request.controller.callsign, sector.controller_cid, sector.controller_callsign, requestGroupId]);
        result.requested.push(name);
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

  app.post("/sectors/release-all", async (request, reply) => transaction(async client => {
    await lockMutations(client);
    const sectors = (await client.query(
      `SELECT s.name FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id
       WHERE o.controller_cid=$1 AND o.controller_callsign=$2`, [request.controller.cid, request.controller.callsign])).rows.map(row => row.name);
    const flights = (await client.query("SELECT callsign FROM flight_data_records WHERE controlling_cid=$1", [request.controller.cid])).rows.map(row => row.callsign);
    await client.query(
      `INSERT INTO resume_snapshots (controller_cid,controller_callsign,sectors,flights,created_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (controller_cid,controller_callsign) DO UPDATE SET sectors=$3,flights=$4,created_at=now()`,
      [request.controller.cid, request.controller.callsign, JSON.stringify(sectors), JSON.stringify(flights)]);
    const freed = (await client.query(
      "DELETE FROM sector_ownerships WHERE controller_cid=$1 AND controller_callsign=$2 RETURNING sector_id",
      [request.controller.cid, request.controller.callsign])).rows.map(row => row.sector_id);
    // Deliberately here and in the disconnect sweep, but NOT in releaseGroup. Those two are the
    // controller leaving; releaseGroup is a deliberate release while still connected, and doing it
    // there would bounce a sub-sector straight back to anyone who also holds its parent, making it
    // impossible to free one by hand.
    await reassignFreedSectors(client, freed);
    await client.query("DELETE FROM sector_requests WHERE requesting_cid=$1 OR target_cid=$1", [request.controller.cid]);
    const clearedFlights = (await client.query(
      "UPDATE flight_data_records SET controlling_cid=NULL,controlling_callsign=NULL WHERE controlling_cid=$1 RETURNING callsign",
      [request.controller.cid])).rows.map(row => row.callsign);
    await writeDiagnosticLog(client, request.controller, "ServerSector", "Released all sectors", {
      action: "release_all",
      sectors,
      sector_ids: freed,
      fdr_authority_cleared: clearedFlights
    });
    return reply.code(204).send();
  }));

  app.post("/sectors/resume", async request => transaction(async client => {
    await lockMutations(client);
    const snapshot = (await client.query(
      "DELETE FROM resume_snapshots WHERE controller_cid=$1 AND controller_callsign=$2 RETURNING *",
      [request.controller.cid, request.controller.callsign])).rows[0];
    const resumed: string[] = [];
    const restoredFlights: string[] = [];
    if (snapshot && Date.now() - new Date(snapshot.created_at).getTime() <= config.RESUME_WINDOW_MINUTES * 60_000) {
      for (const name of snapshot.sectors as string[]) {
        const sector = (await client.query("SELECT id FROM sectors WHERE name=$1", [name])).rows[0];
        if (!sector) continue;
        const inserted = await client.query(
          `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at)
           VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING RETURNING sector_id`, [sector.id, request.controller.cid, request.controller.callsign]);
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
            AND controlling_cid IS NULL
            AND current_sector IN (
                  SELECT s.name FROM sectors s
                    JOIN sector_ownerships o ON o.sector_id=s.id
                   WHERE o.controller_cid=$1)`,
        [request.controller.cid, request.controller.callsign, snapshot.flights]);
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
          AND current_sector IN (
                SELECT s.name FROM sectors s
                  JOIN sector_ownerships o ON o.sector_id=s.id
                 WHERE o.controller_cid=$1)
        ORDER BY callsign`,
      [request.controller.cid])).rows.map(row => row.callsign));

    await writeDiagnosticLog(client, request.controller, "ServerSector", "Resume processed", {
      action: "resume",
      had_snapshot: Boolean(snapshot),
      resumed,
      restored_flights: restoredFlights
    });

    return { resumed, flights: restoredFlights, sync: await syncPayload(client, request.controller) };
  }));

  app.post<{ Params: { id: string } }>("/sector-requests/:id/accept", async (request, reply) => transaction(async client => {
    await lockMutations(client);
    const sector = await transferRequest(client, request.controller, Number(request.params.id));
    return sector ? { message: "Ownership transferred.", sync: await syncPayload(client, request.controller) }
      : reply.code(403).send({ message: "Only the sector's current owner may accept this request." });
  }));

  app.post<{ Body: { request_ids?: number[] } }>("/sector-requests/accept-batch", async request => transaction(async client => {
    await lockMutations(client);
    const results = [];
    for (const id of request.body?.request_ids ?? []) {
      const sector = await transferRequest(client, request.controller, id);
      results.push({ request_id: id, sector, accepted: sector !== null,
        message: sector ? "Ownership transferred." : "Request no longer exists or is not yours to accept." });
    }
    return { results, sync: await syncPayload(client, request.controller) };
  }));

  // Mirrors accept-batch so declining a grouped request is one call rather than one per sector.
  app.post<{ Body: { request_ids?: number[] } }>("/sector-requests/reject-batch", async request => {
    const ids = request.body?.request_ids ?? [];
    const changed = await pool.query(
      "UPDATE sector_requests SET rejected_at=now() WHERE id=ANY($1) AND target_cid=$2 AND rejected_at IS NULL RETURNING id",
      [ids, request.controller.cid]);
    await writeDiagnosticLog(pool, request.controller, "ServerSector", "Rejected request batch", {
      action: "request_reject_batch",
      request_ids: ids.map(String),
      rejected: changed.rows.map(row => Number(row.id))
    });
    return { rejected: changed.rows.map(row => Number(row.id)), sync: await syncPayload(pool, request.controller) };
  });

  app.post<{ Params: { id: string } }>("/sector-requests/:id/reject", async (request, reply) => {
    const changed = await pool.query("UPDATE sector_requests SET rejected_at=now() WHERE id=$1 AND target_cid=$2 AND rejected_at IS NULL RETURNING id", [request.params.id, request.controller.cid]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Rejected request #${request.params.id}`, {
        action: "request_reject",
        request_id: request.params.id
      });
    return changed.rowCount ? { message: "Request rejected.", sync: await syncPayload(pool, request.controller) } : reply.code(403).send({ message: "This request cannot be rejected." });
  });
  app.post<{ Params: { id: string } }>("/sector-requests/:id/cancel", async (request, reply) => {
    const changed = await pool.query("DELETE FROM sector_requests WHERE id=$1 AND requesting_cid=$2 RETURNING id", [request.params.id, request.controller.cid]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Cancelled request #${request.params.id}`, {
        action: "request_cancel",
        request_id: request.params.id
      });
    return changed.rowCount ? { message: "Request cancelled.", sync: await syncPayload(pool, request.controller) } : reply.code(403).send({ message: "This request cannot be cancelled." });
  });
  app.post<{ Params: { id: string } }>("/sector-requests/:id/acknowledge-rejection", async (request, reply) => {
    const changed = await pool.query("DELETE FROM sector_requests WHERE id=$1 AND requesting_cid=$2 AND rejected_at IS NOT NULL RETURNING id", [request.params.id, request.controller.cid]);
    if (changed.rowCount)
      await writeDiagnosticLog(pool, request.controller, "ServerSector", `Acknowledged rejected request #${request.params.id}`, {
        action: "request_acknowledge_rejection",
        request_id: request.params.id
      });
    return changed.rowCount ? reply.code(204).send() : reply.code(404).send({ message: "Rejected request not found." });
  });
}
