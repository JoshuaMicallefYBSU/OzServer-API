import type { FastifyInstance } from "fastify";
import { parseServer } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { afvTransceivers, vatsimData } from "../vatsim.js";

const visibleTypes = ["TWR", "APP", "DEP", "CTR", "FSS"];
const typePriority: Record<string, number> = { FMP: 0, CTR: 1, FSS: 1, APP: 2, DEP: 2, TWR: 3, GND: 3, DEL: 3 };

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { server?: string } }>("/map/sectors", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });

    const rows = (await pool.query(
      `SELECT s.*,o.controller_cid,o.controller_callsign,o.last_seen_online_at FROM sectors s
       JOIN sector_ownerships o ON o.sector_id=s.id AND o.server=$2 WHERE s.type=ANY($1) ORDER BY s.name`,
      [visibleTypes, server])).rows;

    // The real VATSIM public datafeed only ever lists live-network connections, so it can answer
    // "online" for `live` but would read false for every row on the other 3 servers regardless of
    // actual presence there. For those, recency of our own last_seen_online_at (refreshed by every
    // authenticated request - see app.ts's heartbeat hook) is the equivalent signal, the same one
    // claim-takeover already trusts elsewhere (see sectors.ts's isPresent).
    if (server === "live") {
      const online = new Set((await vatsimData())?.controllers?.map(controller => controller.callsign.toUpperCase()) ?? []);
      return rows.map(row => ({
        name: row.name, full_name: row.full_name, callsign: row.callsign, frequency: row.frequency,
        boundary: row.boundary, owner: { cid: row.controller_cid, callsign: row.controller_callsign },
        online: online.has(row.callsign?.toUpperCase())
      }));
    }
    return rows.map(row => ({
      name: row.name, full_name: row.full_name, callsign: row.callsign, frequency: row.frequency,
      boundary: row.boundary, owner: { cid: row.controller_cid, callsign: row.controller_callsign },
      online: row.last_seen_online_at !== null
        && Date.now() - new Date(row.last_seen_online_at).getTime() < config.PRESENCE_TIMEOUT_SECONDS * 1000
    }));
  });

  app.get<{ Querystring: { server?: string } }>("/map/aircraft", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });
    return (await pool.query(
      `SELECT * FROM flight_data_records WHERE server=$2 AND last_seen_at >= now()-($1*interval '1 minute')
        AND (data->>'lat') IS NOT NULL ORDER BY callsign`,
      [config.FDR_RETAIN_MINUTES, server])).rows.map(row => ({ ...row.data, callsign: row.callsign,
        controlling_cid: row.controlling_cid, controlling_callsign: row.controlling_callsign,
        current_sector: row.current_sector, last_seen_at: row.last_seen_at }));
  });

  // Every sector's static geometry, regardless of staffing - unlike /map/sectors (staffed-only,
  // with live ownership/online status), this is what the website's home page decorative map
  // needs: every sector's shape whether or not anyone currently holds it. Global/unscoped:
  // sectors are shared across every server (see migrations/006_server_isolation.sql), so there is
  // nothing to scope here.
  app.get("/map/sector-shapes", async () => (await pool.query(
    "SELECT name,full_name,type,callsign,responsible_sectors,boundary FROM sectors ORDER BY name")).rows);

  app.get<{ Querystring: { server?: string } }>("/map/atis", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });
    return (await pool.query(
      `SELECT a.*,p.default_lat AS lat,p.default_lon AS lon FROM atis_broadcasts a JOIN positions p ON p.asmgcs_airport=a.icao
        WHERE a.server=$2 AND a.last_seen_at >= now()-($1*interval '1 minute')`,
      [config.ATIS_RETAIN_MINUTES, server])).rows;
  });

  app.get<{ Querystring: { server?: string } }>("/map/controllers", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });

    // A sweatbox/localhost connection never appears on VATSIM's real public datafeed, so for
    // anything but `live` this reads straight from our own ownership ledger instead - the only
    // record of who is actually staffing what on those servers. Same response shape as the live
    // branch below, so the website's rendering code needs no changes, only its fetch URL.
    //
    // One row per CONTROLLER, not per sector they own: a controller who claimed a group (e.g. KPL
    // owning 5 sectors) has one sector_ownerships row per covered sub-sector, but should show up
    // once, on their own primary frequency - exactly what the live branch below already does by
    // matching a connected controller's own callsign to a sector. Matching `s.callsign =
    // o.controller_callsign` is the same rule applied to the ownership table instead of the VATSIM
    // datafeed: only the one sector whose own callsign IS this controller's callsign - their "home"
    // position - contributes a row.
    if (server !== "live") {
      const rows = (await pool.query(
        `SELECT s.name AS sector_name, s.type, s.frequency, o.controller_cid AS cid, o.controller_callsign AS callsign
           FROM sector_ownerships o JOIN sectors s ON s.id=o.sector_id
          WHERE o.server=$1 AND s.callsign=o.controller_callsign`, [server])).rows;
      return rows.map(row => ({
        cid: row.cid, callsign: row.callsign,
        frequencies: row.frequency ? [Number(row.frequency)] : [],
        sector_name: row.sector_name, type: row.type, is_ozserver: true
      })).sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99) || a.sector_name.localeCompare(b.sector_name));
    }

    const data = await vatsimData();
    const sectors = new Map((await pool.query("SELECT name,callsign,type FROM sectors WHERE callsign IS NOT NULL")).rows.map(row => [row.callsign, row]));
    const owners = new Set((await pool.query("SELECT DISTINCT controller_cid FROM sector_ownerships WHERE server=$1", [server])).rows.map(row => row.controller_cid));
    const frequencies = new Map((await afvTransceivers()).map(entry => [entry.callsign,
      [...new Set((entry.transceivers ?? []).map(item => Math.round(item.frequency / 1000) / 1000))]]));
    return (data?.controllers ?? []).filter(controller => sectors.has(controller.callsign)).map(controller => {
      const sector = sectors.get(controller.callsign)!;
      return { cid: controller.cid, callsign: controller.callsign,
        frequencies: frequencies.get(controller.callsign) ?? [Number(controller.frequency)],
        sector_name: sector.name, type: sector.type, is_ozserver: owners.has(controller.cid) };
    }).sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99) || a.sector_name.localeCompare(b.sector_name));
  });

  // A bare passthrough of VATSIM's real global AFV feed - inherently meaningless for a
  // sweatbox/localhost session (there is no AFV data for a connection that isn't on the real
  // network), and has no database query of its own to scope. Left global/unscoped; /map/controllers'
  // non-live branch above already covers the practical consequence with a frequency fallback.
  app.get("/afv/transceivers", async () => afvTransceivers());
}
