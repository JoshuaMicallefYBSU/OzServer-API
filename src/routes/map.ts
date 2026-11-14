import type { FastifyInstance } from "fastify";
import { parseServer } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { atisSectionContent, atisTimestamp } from "../network-atis.js";
import { afvTransceivers, vatsimData } from "../vatsim.js";

const visibleTypes = ["TWR", "APP", "DEP", "CTR", "FSS"];
const typePriority: Record<string, number> = { FMP: 0, CTR: 1, FSS: 1, APP: 2, DEP: 2, TWR: 3, GND: 3, DEL: 3 };

// atis_broadcasts keeps a frequency FSD-style - (MHz - 100) * 1000, so 132.500 is stored as 32500
// - where a published ATIS carries the text the controller typed ("126.250"). The map wants the
// one readable form either way.
const fsdFrequency = (value: number | null): string | null =>
  value === null || value === undefined ? null : (100 + value / 1000).toFixed(3);

type AtisMapRow = { icao: string; atis_letter: string; content: unknown; lat: number; lon: number };

// One ATIS as the map draws it, whichever table it came out of. content is rebuilt in ATIS-editor
// order (jsonb does not keep key order, and a vatSys push can carry editor-only tags like MODE
// that are not part of the broadcast); a zulu ATIS's free text passes through as the string it is.
function mapAtis(row: AtisMapRow, type: string, frequency: string | null, time: Date | string | null, changed: string[]) {
  return {
    icao: row.icao,
    lat: row.lat,
    lon: row.lon,
    atis_letter: row.atis_letter,
    type,
    frequency,
    content: typeof row.content === "string" ? row.content
      : atisSectionContent((row.content ?? {}) as Record<string, string | null>),
    changed,
    issued: atisTimestamp(time)
  };
}

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
    // Every recent record, position or not: an activated FDR still at the gate, or a completed one,
    // is drawn at its aerodrome (dep_lat/des_lat, which the plugin sends) rather than where it is.
    return (await pool.query(
      `SELECT * FROM flight_data_records WHERE server=$2 AND last_seen_at >= now()-($1*interval '1 minute')
        ORDER BY callsign`,
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
    "SELECT name,full_name,type,callsign,frequency,responsible_sectors,boundary FROM sectors ORDER BY name")).rows);

  // The /ops page's whole live picture in one call: who holds which sector, every controller with
  // the full set they hold, the requests between them and the shared notes/drawings. Geometry is not
  // in here - the page loads /map/sector-shapes once and joins this onto it by sector name, so this
  // stays small enough to re-read on every "sectors"/"annotations" signal.
  //
  // Read-only and public like the rest of /map: nothing here is more than what every connected
  // controller already sees in their own Sectors window, and none of it can be acted on from a
  // browser. Presence is judged from our own heartbeat (last_seen_online_at) for every server, live
  // included - it is the signal the disconnect sweep itself trusts, and it has none of the
  // datafeed's publish lag.
  app.get<{ Querystring: { server?: string } }>("/map/ops", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });

    const [ownerships, requests, annotations] = await Promise.all([
      pool.query(
        `SELECT s.name, s.callsign AS sector_callsign, s.type, s.frequency,
                o.controller_cid, o.controller_callsign, o.last_seen_online_at, o.created_at, o.updated_at
           FROM sector_ownerships o JOIN sectors s ON s.id=o.sector_id
          WHERE o.server=$1 ORDER BY s.name`, [server]),
      pool.query(
        `SELECT r.id, r.group_id, s.name AS sector, r.requesting_cid, r.requesting_callsign,
                r.target_cid, r.target_callsign, r.created_at, r.rejected_at
           FROM sector_requests r JOIN sectors s ON s.id=r.sector_id
          WHERE r.server=$1 AND (r.rejected_at IS NULL OR r.rejected_at >= now()-interval '10 minutes')
          ORDER BY r.created_at`, [server]),
      pool.query(
        `SELECT id, kind, author_cid, author_callsign, body, points, colour, created_at, updated_at
           FROM annotations WHERE server=$1 ORDER BY created_at`, [server])
    ]);

    const timeoutMs = config.PRESENCE_TIMEOUT_SECONDS * 1000;
    const now = Date.now();
    const isFlow = (callsign: string | null | undefined) => !!callsign && callsign.toUpperCase().endsWith("_FMP");

    type OpsController = {
      cid: number; callsign: string; is_flow: boolean; online: boolean; last_seen_at: string | null;
      home_sector: string | null; type: string | null; frequency: string | null; sectors: string[];
    };
    const controllers = new Map<string, OpsController>();
    for (const row of ownerships.rows) {
      const key = `${row.controller_cid}|${row.controller_callsign}`;
      let controller = controllers.get(key);
      if (!controller) {
        controller = {
          cid: row.controller_cid, callsign: row.controller_callsign, is_flow: isFlow(row.controller_callsign),
          online: false, last_seen_at: null, home_sector: null, type: null, frequency: null, sectors: []
        };
        controllers.set(key, controller);
      }
      controller.sectors.push(row.name);
      const seen = row.last_seen_online_at ? new Date(row.last_seen_online_at) : null;
      if (seen && (!controller.last_seen_at || seen.getTime() > new Date(controller.last_seen_at).getTime())) {
        controller.last_seen_at = seen.toISOString();
        controller.online = now - seen.getTime() < timeoutMs;
      }
      // The "home" position is the sector whose own callsign is the controller's login callsign -
      // the same rule /map/controllers uses. Someone covering only other positions has none.
      if (row.sector_callsign && row.sector_callsign.toUpperCase() === String(row.controller_callsign).toUpperCase()) {
        controller.home_sector = row.name;
        controller.type = row.type;
        controller.frequency = row.frequency;
      }
    }

    return {
      server,
      generated_at: new Date().toISOString(),
      presence_timeout_seconds: config.PRESENCE_TIMEOUT_SECONDS,
      ownerships: ownerships.rows.map(row => ({
        sector: row.name, cid: row.controller_cid, callsign: row.controller_callsign,
        since: row.updated_at ?? row.created_at, last_seen_at: row.last_seen_online_at
      })),
      controllers: [...controllers.values()].sort((a, b) =>
        (typePriority[a.type ?? ""] ?? 99) - (typePriority[b.type ?? ""] ?? 99) || a.callsign.localeCompare(b.callsign)),
      requests: requests.rows.map(row => ({
        id: Number(row.id), group_id: row.group_id, sector: row.sector,
        requesting_cid: row.requesting_cid, requesting_callsign: row.requesting_callsign,
        target_cid: row.target_cid, target_callsign: row.target_callsign,
        is_flow_relief: isFlow(row.requesting_callsign),
        created_at: row.created_at, rejected_at: row.rejected_at
      })),
      annotations: annotations.rows.map(row => ({
        id: row.id, kind: row.kind, author: { cid: row.author_cid, callsign: row.author_callsign },
        body: row.body, points: row.points, colour: row.colour, created_at: row.created_at, updated_at: row.updated_at
      }))
    };
  });

  // Every ATIS the map can draw, in one shape whichever way it reached this server: the ones a
  // vatSys ATIS plugin published (network_atis - see routes/atis.ts), and, for an airport that has
  // no published ATIS, the vatSys ATIS an OzServer controller's own client pushed
  // (atis_broadcasts). Published wins where both exist: it is the broadcast itself, with its
  // sections, its letter and the time the controller issued it, rather than our record of what one
  // controller's plugin last sent us.
  //
  // Only an airport the dataset holds a position for can be drawn, since that is where lat/lon
  // comes from - an ATIS published for anywhere else is still served by /vatsim/atis, just not
  // placed on the map.
  app.get<{ Querystring: { server?: string } }>("/map/atis", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });
    // ?server= scopes the atis_broadcasts half only: network_atis has no server of its own (an
    // ATIS is a broadcast on the network), so the published ones are the same on every view.
    const published = (await pool.query(
      `SELECT a.icao,a.atis_letter,a.type,a.frequency,a.content,a.changed,a.issued,
              p.default_lat AS lat,p.default_lon AS lon
         FROM network_atis a JOIN positions p ON p.asmgcs_airport=a.icao`)).rows;
    const pushed = (await pool.query(
      `SELECT a.icao,a.atis_letter,a.frequency,a.content,a.last_seen_at,
              p.default_lat AS lat,p.default_lon AS lon
         FROM atis_broadcasts a JOIN positions p ON p.asmgcs_airport=a.icao
        WHERE a.server=$2 AND a.last_seen_at >= now()-($1*interval '1 minute')
          AND NOT EXISTS (SELECT 1 FROM network_atis n WHERE n.icao=a.icao)`,
      [config.ATIS_RETAIN_MINUTES, server])).rows;
    return [
      ...published.map(row => mapAtis(row, row.type, row.frequency, row.issued, row.changed)),
      // atis_broadcasts holds no issue time of its own, so the time it last reached us stands in,
      // and nothing in it is marked as changed - vatSys sends that plugin the content only.
      ...pushed.map(row => mapAtis(row, "atis", fsdFrequency(row.frequency), row.last_seen_at, []))
    ];
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
