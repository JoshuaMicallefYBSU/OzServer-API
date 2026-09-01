import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { config } from "../config.js";
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
  request: z.array(z.string()).default([])
});

async function lockMutations(client: pg.PoolClient): Promise<void> {
  // Sector groups overlap. One transaction-wide lock makes the complete check-and-write operation
  // atomic, including claims involving responsible sectors and batch commits.
  await client.query("SELECT pg_advisory_xact_lock(684276)");
}

async function covered(client: pg.PoolClient, name: string): Promise<SectorRow[]> {
  const primary = await client.query<SectorRow>(
    `SELECT s.*, o.controller_cid, o.controller_callsign, o.last_seen_online_at
       FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.name=$1`, [name]);
  const sector = primary.rows[0];
  if (!sector) return [];
  const names = [sector.name, ...(sector.responsible_sectors ?? [])];
  return (await client.query<SectorRow>(
    `SELECT s.*, o.controller_cid, o.controller_callsign, o.last_seen_online_at
       FROM sectors s LEFT JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.name = ANY($1)`, [names])).rows;
}

function isWithinGrace(row: SectorRow): boolean {
  return row.last_seen_online_at !== null
    && Date.now() - new Date(row.last_seen_online_at).getTime() < config.DISCONNECT_GRACE_MINUTES * 60_000;
}

async function claimGroup(
  client: pg.PoolClient,
  identity: ControllerIdentity,
  name: string,
  online: Map<string, number> | null,
  exclusions: string[] = [],
  allOrNothing = false
): Promise<{ claimed: string[]; skipped: string[]; conflicts: Array<{ sector: string; owner: { cid: number; callsign: string } }>; missing: boolean }> {
  const rows = (await covered(client, name)).filter(row => !exclusions.includes(row.name));
  if (rows.length === 0) return { claimed: [], skipped: [], conflicts: [], missing: true };
  const takeable: SectorRow[] = [];
  const skipped: string[] = [];
  const conflicts: Array<{ sector: string; owner: { cid: number; callsign: string } }> = [];

  for (const row of rows) {
    if (row.controller_cid === null || row.controller_cid === identity.cid
      || row.callsign?.toUpperCase() === identity.callsign.toUpperCase()) {
      takeable.push(row);
      continue;
    }
    const ownerOnline = online?.get(row.controller_callsign?.toUpperCase() ?? "") === row.controller_cid;
    if (ownerOnline || isWithinGrace(row)) {
      skipped.push(row.name);
      conflicts.push({ sector: row.name, owner: { cid: row.controller_cid, callsign: row.controller_callsign ?? "" } });
    }
    else takeable.push(row);
  }

  if (allOrNothing && conflicts.length) return { claimed: [], skipped, conflicts, missing: false };

  for (const row of takeable) {
    await client.query(
      `INSERT INTO sector_ownerships (sector_id, controller_cid, controller_callsign, last_seen_online_at)
       VALUES ($1,$2,$3,now()) ON CONFLICT (sector_id) DO UPDATE SET
       controller_cid=excluded.controller_cid, controller_callsign=excluded.controller_callsign,
       last_seen_online_at=now(), updated_at=now()`, [row.id, identity.cid, identity.callsign]);
  }
  return { claimed: takeable.map(row => row.name), skipped, conflicts, missing: false };
}

async function requestsPayload(client: pg.Pool | pg.PoolClient, identity: ControllerIdentity) {
  const rows = (await client.query(
    `SELECT r.*, s.name AS sector_name, s.full_name AS sector_full_name
       FROM sector_requests r JOIN sectors s ON s.id=r.sector_id
      WHERE r.requesting_cid=$1 OR r.target_cid=$1 ORDER BY r.created_at`, [identity.cid])).rows;
  const map = (row: Record<string, unknown>) => ({
    id: Number(row.id), sector_id: Number(row.sector_id), requesting_cid: row.requesting_cid,
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
  return true;
}

async function transferRequest(client: pg.PoolClient, identity: ControllerIdentity, id: number): Promise<string | null> {
  const result = await client.query(
    `SELECT r.*,s.name FROM sector_requests r JOIN sectors s ON s.id=r.sector_id WHERE r.id=$1 FOR UPDATE`, [id]);
  const request = result.rows[0];
  if (!request || request.target_cid !== identity.cid) return null;
  const owner = await client.query("SELECT controller_cid FROM sector_ownerships WHERE sector_id=$1 FOR UPDATE", [request.sector_id]);
  if (owner.rows[0]?.controller_cid !== identity.cid) return null;
  const rows = await covered(client, request.name);
  for (const row of rows) {
    await client.query(
      `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at)
       VALUES ($1,$2,$3,now()) ON CONFLICT (sector_id) DO UPDATE SET controller_cid=$2,
       controller_callsign=$3,last_seen_online_at=now(),updated_at=now()`,
      [row.id, request.requesting_cid, request.requesting_callsign]);
  }
  await client.query("DELETE FROM sector_requests WHERE sector_id=ANY($1)", [rows.map(row => row.id)]);
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
    return reply.code(201).send(inserted.rows[0]);
  }));

  app.post("/sectors/commit", async (request, reply) => {
    const parsed = mutationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid sector commit.", errors: parsed.error.flatten() });
    return transaction(async client => {
      await lockMutations(client);
      const result = { claimed: [] as string[], released: [] as string[], requested: [] as string[], skipped: [] as string[], failed: [] as string[] };
      for (const name of parsed.data.release) (await releaseGroup(client, request.controller, name) ? result.released : result.failed).push(name);
      const online = await onlineControllers();
      for (const name of parsed.data.claim) {
        const claimed = await claimGroup(client, request.controller, name, online);
        if (claimed.missing) result.failed.push(name); else { result.claimed.push(...claimed.claimed); result.skipped.push(...claimed.skipped); }
      }
      for (const name of parsed.data.request) {
        const sector = (await client.query(
          `SELECT s.id,o.controller_cid,o.controller_callsign FROM sectors s JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.name=$1`, [name])).rows[0];
        if (!sector || sector.controller_cid === request.controller.cid) { result.failed.push(name); continue; }
        await client.query("DELETE FROM sector_requests WHERE sector_id=$1 AND requesting_cid=$2 AND rejected_at IS NOT NULL", [sector.id, request.controller.cid]);
        await client.query(
          `INSERT INTO sector_requests (sector_id,requesting_cid,requesting_callsign,target_cid,target_callsign)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sector_id,requesting_cid) DO NOTHING`,
          [sector.id, request.controller.cid, request.controller.callsign, sector.controller_cid, sector.controller_callsign]);
        result.requested.push(name);
      }
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
    await client.query("UPDATE flight_data_records SET controlling_cid=NULL,controlling_callsign=NULL WHERE controlling_cid=$1", [request.controller.cid]);
    return reply.code(204).send();
  }));

  app.post("/sectors/resume", async request => transaction(async client => {
    await lockMutations(client);
    const snapshot = (await client.query(
      "DELETE FROM resume_snapshots WHERE controller_cid=$1 AND controller_callsign=$2 RETURNING *",
      [request.controller.cid, request.controller.callsign])).rows[0];
    const resumed: string[] = [];
    if (snapshot && Date.now() - new Date(snapshot.created_at).getTime() <= config.RESUME_WINDOW_MINUTES * 60_000) {
      for (const name of snapshot.sectors as string[]) {
        const sector = (await client.query("SELECT id FROM sectors WHERE name=$1", [name])).rows[0];
        if (!sector) continue;
        const inserted = await client.query(
          `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at)
           VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING RETURNING sector_id`, [sector.id, request.controller.cid, request.controller.callsign]);
        if (inserted.rows[0]) resumed.push(name);
      }
      await client.query(
        `UPDATE flight_data_records SET controlling_cid=$1,controlling_callsign=$2
         WHERE callsign=ANY($3) AND (controlling_cid IS NULL OR controlling_cid=$1)`,
        [request.controller.cid, request.controller.callsign, snapshot.flights]);
    }
    return { resumed, sync: await syncPayload(client, request.controller) };
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

  app.post<{ Params: { id: string } }>("/sector-requests/:id/reject", async (request, reply) => {
    const changed = await pool.query("UPDATE sector_requests SET rejected_at=now() WHERE id=$1 AND target_cid=$2 AND rejected_at IS NULL RETURNING id", [request.params.id, request.controller.cid]);
    return changed.rowCount ? { message: "Request rejected.", sync: await syncPayload(pool, request.controller) } : reply.code(403).send({ message: "This request cannot be rejected." });
  });
  app.post<{ Params: { id: string } }>("/sector-requests/:id/cancel", async (request, reply) => {
    const changed = await pool.query("DELETE FROM sector_requests WHERE id=$1 AND requesting_cid=$2 RETURNING id", [request.params.id, request.controller.cid]);
    return changed.rowCount ? { message: "Request cancelled.", sync: await syncPayload(pool, request.controller) } : reply.code(403).send({ message: "This request cannot be cancelled." });
  });
  app.post<{ Params: { id: string } }>("/sector-requests/:id/acknowledge-rejection", async (request, reply) => {
    const changed = await pool.query("DELETE FROM sector_requests WHERE id=$1 AND requesting_cid=$2 AND rejected_at IS NOT NULL RETURNING id", [request.params.id, request.controller.cid]);
    return changed.rowCount ? reply.code(204).send() : reply.code(404).send({ message: "Rejected request not found." });
  });
}
