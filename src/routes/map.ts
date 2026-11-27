import type { FastifyInstance } from "fastify";
import { parseServer } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { atisSectionContent, atisTimestamp } from "../network-atis.js";
import { externalHoldings } from "../external-control.js";
import { REGIONS } from "../regions.js";
import { afvTransceivers, vatsimData, type Pilot } from "../vatsim.js";

const visibleTypes = ["TWR", "APP", "DEP", "CTR", "FSS"];
const typePriority: Record<string, number> = { FMP: 0, CTR: 1, FSS: 1, APP: 2, DEP: 2, TWR: 3, GND: 3, DEL: 3 };

// atis_broadcasts keeps a frequency FSD-style - (MHz - 100) * 1000, so 132.500 is stored as 32500
// - where a published ATIS carries it as text ("126.250"). The map is given the text form for both.
const fsdFrequency = (value: number | null): string | null =>
  value === null || value === undefined ? null : (100 + value / 1000).toFixed(3);

// Every sector boundary ring, for /map/traffic's point-in-airspace test. The dataset changes only
// when sync-dataset runs, so the rings are read at most every ten minutes.
//
// Longitudes are taken onto 0-360 (as is the pilot's, in insideRing): the oceanic sectors run out
// past 180 degrees, and on -180..180 a ring crossing the antimeridian would wrap the wrong way.
// With its bounding box: most pilots are nowhere near most sectors, and the box rules a ring out
// without walking its points.
type Ring = { points: Array<[number, number]>; minLon: number; maxLon: number; minLat: number; maxLat: number; region: string }; // [lon 0-360, lat]
let ringCache: { expires: number; rings: Ring[] } = { expires: 0, rings: [] };
const eastLon = (lon: number) => (lon < 0 ? lon + 360 : lon);

// The area /map/pilots serves for each region: a little more than the homepage's chart of it shows.
// New Zealand's runs past 180 degrees (the Chatham Islands), so its longitudes are read on 0-360.
const PILOT_BOXES: Record<string, { lat: [number, number]; lon: [number, number]; eastward?: boolean }> = {
  "australia": { lat: [-50, 0], lon: [100, 170] },
  "new-zealand": { lat: [-56, -24], lon: [150, 196], eastward: true },
  "mexico": { lat: [2, 41], lon: [-128, -78] }
};

async function sectorPolygons(): Promise<Ring[]> {
  if (ringCache.expires > Date.now()) return ringCache.rings;
  const rows = (await pool.query("SELECT boundary,region FROM sectors")).rows;
  const rings: Ring[] = [];
  for (const row of rows) {
    for (const ring of (Array.isArray(row.boundary) ? row.boundary : [])) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const points: Array<[number, number]> = ring
        .map((point: { lat: number; lon: number }): [number, number] => [eastLon(Number(point.lon)), Number(point.lat)])
        .filter(([lon, lat]: [number, number]) => Number.isFinite(lon) && Number.isFinite(lat));
      if (points.length < 3) continue;
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const [lon, lat] of points) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      rings.push({ points, minLon, maxLon, minLat, maxLat, region: String(row.region) });
    }
  }
  ringCache = { expires: Date.now() + 10 * 60_000, rings };
  return rings;
}

// Ray casting: odd crossings of a ray running east from the point means inside.
function insideRing(ring: Ring, lat: number, lon: number): boolean {
  const x = eastLon(lon);
  if (x < ring.minLon || x > ring.maxLon || lat < ring.minLat || lat > ring.maxLat) return false;
  const points = ring.points;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    // Both indices are in range by construction; the assertion is for noUncheckedIndexedAccess.
    const [xi, yi] = points[i]!, [xj, yj] = points[j]!;
    if ((yi > lat) !== (yj > lat) && x < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The pilots inside the dataset's airspace, worked out once per datafeed rather than once per
// request. Every open homepage asks /map/traffic every 15 s, and testing each pilot against each
// boundary on every one of those calls held the event loop for a fifth of a second at a time -
// time taken from every controller's heartbeat. Keyed on the feed's own pilot list and the ring
// list, both of which are replaced, never changed in place, when they are refreshed.
// Each pilot inside comes with the region of the first boundary found around them.
type Inside = { callsign: string; region: string };
let trafficCache: { pilots: Pilot[]; rings: Ring[]; inside: Inside[] } | null = null;

function pilotsInAirspace(pilots: Pilot[], rings: Ring[]): Inside[] {
  if (trafficCache && trafficCache.pilots === pilots && trafficCache.rings === rings) return trafficCache.inside;
  const inside: Inside[] = [];
  for (const pilot of pilots) {
    if (!Number.isFinite(pilot.latitude) || !Number.isFinite(pilot.longitude)) continue;
    const ring = rings.find(candidate => insideRing(candidate, pilot.latitude, pilot.longitude));
    if (ring) inside.push({ callsign: String(pilot.callsign).toUpperCase(), region: ring.region });
  }
  trafficCache = { pilots, rings, inside };
  return inside;
}

type AtisMapRow = { icao: string; atis_letter: string; content: unknown; lat: number; lon: number; region: string };

// Whether the station behind an ATIS record is on the network, as opposed to a record this server
// is still holding after its controller left (records cannot be withdrawn - they age out). The map
// draws the two differently.
//
// On the live network VATSIM's datafeed answers: it lists every connected ATIS station. It lags a
// new connection by up to a minute, so a record heard from in the last two minutes counts as
// connected regardless. Where the feed cannot answer (it is unreachable, or this is a SweatBox
// ATIS, which it never lists) the re-push decides: both ATIS paths re-send every 20 minutes while
// broadcasting, so one not heard from in 25 has stopped.
const ATIS_JUST_HEARD_MS = 2 * 60_000;
const ATIS_REPUSH_MS = 25 * 60_000;

function atisConnected(station: string, heardAt: Date | string | null, onNetwork: Set<string> | null): boolean {
  const age = heardAt === null ? Infinity : Date.now() - new Date(heardAt).getTime();
  if (onNetwork === null) return age < ATIS_REPUSH_MS;
  return age < ATIS_JUST_HEARD_MS || onNetwork.has(station.toUpperCase());
}

// One ATIS as the map draws it, whichever table it came out of. content is rebuilt in ATIS-editor
// order (jsonb does not keep key order, and a vatSys push can carry editor-only tags like MODE
// that are not part of the broadcast); a zulu ATIS's free text passes through as the string it is.
function mapAtis(row: AtisMapRow, type: string, frequency: string | null, time: Date | string | null, changed: string[], connected: boolean) {
  return {
    icao: row.icao,
    lat: row.lat,
    lon: row.lon,
    region: row.region,
    atis_letter: row.atis_letter,
    type,
    frequency,
    content: typeof row.content === "string" ? row.content
      : atisSectionContent((row.content ?? {}) as Record<string, string | null>),
    changed,
    issued: atisTimestamp(time),
    connected
  };
}

// Which region (regions.ts) each sector is in, by name and by callsign, and each callsign prefix
// ("ML", "NZAA", "MMMX") - for the console's region filter, which places controllers and log lines
// by these. Static between dataset syncs, so built at most every ten minutes.
type SectorRegions = { sectors: Record<string, string>; callsigns: Record<string, string>; prefixes: Record<string, string> };
let sectorRegionsCache: { expires: number; value: SectorRegions | null } = { expires: 0, value: null };

async function sectorRegions(): Promise<SectorRegions> {
  if (sectorRegionsCache.value && sectorRegionsCache.expires > Date.now()) return sectorRegionsCache.value;
  const rows = (await pool.query<{ name: string; callsign: string | null; region: string }>(
    "SELECT name,callsign,region FROM sectors ORDER BY name")).rows;
  const value: SectorRegions = { sectors: {}, callsigns: {}, prefixes: {} };
  const prefixRegions = new Map<string, Set<string>>();
  for (const row of rows) {
    value.sectors[row.name] = row.region;
    if (!row.callsign) continue;
    const callsign = row.callsign.toUpperCase();
    value.callsigns[callsign] ??= row.region;
    const prefix = callsign.split(/[-_]/)[0]!;
    prefixRegions.set(prefix, (prefixRegions.get(prefix) ?? new Set()).add(row.region));
  }
  // A prefix used in two regions says nothing, so only those in one are given.
  for (const [prefix, regions] of prefixRegions) if (regions.size === 1) value.prefixes[prefix] = [...regions][0]!;
  sectorRegionsCache = { expires: Date.now() + 10 * 60_000, value };
  return value;
}

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.get("/map/sector-regions", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=600");
    return sectorRegions();
  });

  app.get<{ Querystring: { server?: string } }>("/map/sectors", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });

    const rows = (await pool.query(
      `SELECT s.*,o.controller_cid,o.controller_callsign,o.last_seen_online_at FROM sectors s
       JOIN sector_ownerships o ON o.sector_id=s.id AND o.server=$2 WHERE s.type=ANY($1) ORDER BY s.name`,
      [visibleTypes, server])).rows;

    // And those worked by controllers without the plugin (external-control.ts), as online and
    // marked external.
    const external = await externalHoldings(pool, server);
    const externalRows = external.holdings.size === 0 ? [] : (await pool.query(
      "SELECT * FROM sectors WHERE name=ANY($1) AND type=ANY($2) ORDER BY name", [[...external.holdings.keys()], visibleTypes])).rows
      .map(row => {
        const holding = external.holdings.get(row.name)!;
        return {
          name: row.name, full_name: row.full_name, callsign: row.callsign, frequency: row.frequency,
          boundary: row.boundary, region: row.region, owner: { cid: holding.cid, callsign: holding.callsign }, online: true, external: true
        };
      });

    // VATSIM's datafeed lists live-network connections only, so it answers "online" for `live`.
    // For the other servers, recency of last_seen_online_at is the equivalent signal (see
    // sectors.ts isPresent).
    if (server === "live") {
      const online = new Set((await vatsimData())?.controllers?.map(controller => controller.callsign.toUpperCase()) ?? []);
      return [...rows.map(row => ({
        name: row.name, full_name: row.full_name, callsign: row.callsign, frequency: row.frequency,
        boundary: row.boundary, region: row.region, owner: { cid: row.controller_cid, callsign: row.controller_callsign },
        online: online.has(row.callsign?.toUpperCase())
      })), ...externalRows];
    }
    return [...rows.map(row => ({
      name: row.name, full_name: row.full_name, callsign: row.callsign, frequency: row.frequency,
      boundary: row.boundary, region: row.region, owner: { cid: row.controller_cid, callsign: row.controller_callsign },
      online: row.last_seen_online_at !== null
        && Date.now() - new Date(row.last_seen_online_at).getTime() < config.PRESENCE_TIMEOUT_SECONDS * 1000
    })), ...externalRows];
  });

  app.get<{ Querystring: { server?: string } }>("/map/aircraft", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });
    // Every recent record, position or not: an activated FDR still at the gate, or a completed one,
    // is drawn at its aerodrome (dep_lat/des_lat, which the plugin sends) rather than where it is.
    //
    // region (the map banner it is shown under - see regions.ts) is that of the sector it is in, or
    // failing that of a sector its controller holds, or of its departure or destination aerodrome.
    // Null when none of those is known; the map then shows it whatever regions are switched on.
    return (await pool.query(
      `SELECT f.*, COALESCE(cs.region, ctl.region, dep.region, des.region) AS region
         FROM flight_data_records f
         LEFT JOIN sectors cs ON cs.name=f.current_sector
         LEFT JOIN LATERAL (SELECT s.region FROM sector_ownerships o JOIN sectors s ON s.id=o.sector_id
                             WHERE o.server=f.server AND o.controller_callsign=f.controlling_callsign LIMIT 1) ctl ON true
         LEFT JOIN LATERAL (SELECT region FROM positions WHERE asmgcs_airport=f.data->>'dep_airport' LIMIT 1) dep ON true
         LEFT JOIN LATERAL (SELECT region FROM positions WHERE asmgcs_airport=f.data->>'des_airport' LIMIT 1) des ON true
        WHERE f.server=$2 AND f.last_seen_at >= now()-($1*interval '1 minute')
        ORDER BY f.callsign`,
      [config.FDR_RETAIN_MINUTES, server])).rows.map(row => {
        // Routes are served by /map/routes instead: dozens of points per flight would multiply the
        // size of a feed the map re-reads on every FDR signal. has_route lets the map know one exists.
        const { route_points: routePoints, ...data } = (row.data ?? {}) as Record<string, unknown>;
        return { ...data, callsign: row.callsign, has_route: Array.isArray(routePoints) && routePoints.length > 1,
          controlling_cid: row.controlling_cid, controlling_callsign: row.controlling_callsign,
          current_sector: row.current_sector, last_seen_at: row.last_seen_at, region: row.region };
      });
  });

  // Every recent FDR's route as vatSys parsed it (route_points, pushed by the plugin), with the
  // index of the next waypoint still to be flown. Fetched by the map only while routes are shown.
  app.get<{ Querystring: { server?: string } }>("/map/routes", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });
    // A record's data is whatever its plugin sent (flightSchema passes unknown fields through), so
    // the index is read only where it is a number in range: cast blindly, one record carrying
    // anything else failed this query for every viewer until it aged out.
    return (await pool.query(
      `SELECT callsign, data->'route_points' AS route_points,
              CASE WHEN jsonb_typeof(data->'route_next_index')='number' THEN
                CASE WHEN (data->>'route_next_index')::numeric BETWEEN 0 AND 100000
                     THEN floor((data->>'route_next_index')::numeric)::int END
              END AS route_next_index
         FROM flight_data_records
        WHERE server=$2 AND last_seen_at >= now()-($1*interval '1 minute')
          AND jsonb_typeof(data->'route_points')='array'
        ORDER BY callsign`,
      [config.FDR_RETAIN_MINUTES, server])).rows;
  });

  // Every sector's static geometry, staffed or not - unlike /map/sectors, which returns owned
  // sectors only, with their owner and online status. Takes no ?server=: sectors are shared across
  // every server (see migrations/006_server_isolation.sql).
  app.get("/map/sector-shapes", async () => (await pool.query(
    "SELECT name,full_name,type,callsign,frequency,responsible_sectors,boundary,region FROM sectors ORDER BY name")).rows);

  // The /live-map page's live picture in one call: who holds which sector, every controller with
  // the set they hold, and the requests between them. Geometry is left to /map/sector-shapes
  // (joined by sector name), so this stays small enough to re-read on every "sectors" signal.
  //
  // Public like the rest of /map: it shows no more than every connected controller sees in their
  // own Sectors window. Presence is judged from last_seen_online_at for every server, live
  // included, since it has none of the datafeed's publish lag.
  app.get<{ Querystring: { server?: string } }>("/map/ops", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });

    const [ownerships, requests] = await Promise.all([
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
          ORDER BY r.created_at`, [server])
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

    // Airspace worked by controllers without the plugin (external-control.ts): held, but not
    // through OzServer, so drawn apart from the ownerships above.
    const external = await externalHoldings(pool, server);

    return {
      server,
      generated_at: new Date().toISOString(),
      presence_timeout_seconds: config.PRESENCE_TIMEOUT_SECONDS,
      external: [...external.holdings.values()].sort((a, b) => a.sector.localeCompare(b.sector)),
      external_controllers: external.controllers,
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
      }))
    };
  });

  // Every ATIS the map can draw, in one shape: those a vatSys ATIS plugin published (network_atis
  // - see routes/atis.ts) and, for an airport with none, the one an OzServer controller's client
  // pushed (atis_broadcasts). Only an airport the dataset holds a position for can be drawn, since
  // that is where lat/lon comes from; an ATIS for anywhere else is still served by /vatsim/atis.
  app.get<{ Querystring: { server?: string } }>("/map/atis", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });
    // ?server= scopes the atis_broadcasts half only: network_atis has no server column, so the
    // published ones are the same on every view.
    const published = (await pool.query(
      `SELECT a.icao,a.callsign,a.atis_letter,a.type,a.frequency,a.content,a.changed,a.issued,a.received_at,
              p.default_lat AS lat,p.default_lon AS lon,p.region
         FROM network_atis a JOIN positions p ON p.asmgcs_airport=a.icao`)).rows;
    const pushed = (await pool.query(
      `SELECT a.icao,a.atis_letter,a.frequency,a.content,a.last_seen_at,
              p.default_lat AS lat,p.default_lon AS lon,p.region
         FROM atis_broadcasts a JOIN positions p ON p.asmgcs_airport=a.icao
        WHERE a.server=$2 AND a.last_seen_at >= now()-($1*interval '1 minute')
          AND NOT EXISTS (SELECT 1 FROM network_atis n WHERE n.icao=a.icao)`,
      [config.ATIS_RETAIN_MINUTES, server])).rows;
    // Every ATIS station connected to the live network, or null when the feed has nothing to say.
    const feed = (await vatsimData())?.atis;
    const onNetwork = feed ? new Set(feed.map(station => station.callsign.toUpperCase())) : null;
    // A pushed ATIS has no station callsign on record; vatSys connects one as <ICAO>_ATIS. Only the
    // live view can ask the feed about it - a SweatBox ATIS is never listed there.
    const pushedOnNetwork = server === "live" ? onNetwork : null;
    return [
      ...published.map(row => mapAtis(row, row.type, row.frequency, row.issued, row.changed,
        atisConnected(row.callsign, row.received_at, onNetwork))),
      // atis_broadcasts holds no issue time, so the time it last reached us stands in, and it
      // records no change markers.
      ...pushed.map(row => mapAtis(row, "atis", fsdFrequency(row.frequency), row.last_seen_at, [],
        atisConnected(`${row.icao}_ATIS`, row.last_seen_at, pushedOnNetwork)))
    ];
  });

  app.get<{ Querystring: { server?: string } }>("/map/controllers", async (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });

    // A SweatBox connection never appears on VATSIM's datafeed, so anything but `live` reads
    // sector_ownerships instead, in the same response shape. One row per controller, not per
    // sector they own: only the sector whose callsign is the controller's own (their "home"
    // position) contributes a row, the same rule the live branch applies to the datafeed.
    if (server !== "live") {
      const rows = (await pool.query(
        `SELECT s.name AS sector_name, s.type, s.frequency, s.region, o.controller_cid AS cid, o.controller_callsign AS callsign
           FROM sector_ownerships o JOIN sectors s ON s.id=o.sector_id
          WHERE o.server=$1 AND s.callsign=o.controller_callsign`, [server])).rows;
      // And the controllers without the plugin that the plugins can see (external-control.ts), on
      // the position named by their callsign, or failing that the first sector they work.
      const external = await externalHoldings(pool, server);
      const shapes = new Map((await pool.query("SELECT name,callsign,type,region FROM sectors WHERE name=ANY($1)",
        [external.controllers.flatMap(controller => controller.sectors)])).rows.map(row => [row.name, row]));
      const externalRows = external.controllers.map(controller => {
        const home = controller.sectors.map(name => shapes.get(name)).find(sector => sector?.callsign?.toUpperCase() === controller.callsign)
          ?? shapes.get(controller.sectors[0] ?? "");
        return {
          cid: controller.cid, callsign: controller.callsign, frequencies: controller.frequencies.map(Number),
          sector_name: home?.name ?? null, type: home?.type ?? null, region: home?.region ?? null, is_ozserver: false
        };
      });
      return [...rows.map(row => ({
        cid: row.cid, callsign: row.callsign,
        frequencies: row.frequency ? [Number(row.frequency)] : [],
        sector_name: row.sector_name, type: row.type, region: row.region, is_ozserver: true
      })), ...externalRows].sort((a, b) => (typePriority[a.type ?? ""] ?? 99) - (typePriority[b.type ?? ""] ?? 99)
        || (a.sector_name ?? "").localeCompare(b.sector_name ?? ""));
    }

    const data = await vatsimData();
    const sectors = new Map((await pool.query("SELECT name,callsign,type,region FROM sectors WHERE callsign IS NOT NULL")).rows.map(row => [row.callsign, row]));
    const owners = new Set((await pool.query("SELECT DISTINCT controller_cid FROM sector_ownerships WHERE server=$1", [server])).rows.map(row => row.controller_cid));
    const frequencies = new Map((await afvTransceivers()).map(entry => [entry.callsign,
      [...new Set((entry.transceivers ?? []).map(item => Math.round(item.frequency / 1000) / 1000))]]));
    return (data?.controllers ?? []).filter(controller => sectors.has(controller.callsign)).map(controller => {
      const sector = sectors.get(controller.callsign)!;
      return { cid: controller.cid, callsign: controller.callsign,
        frequencies: frequencies.get(controller.callsign) ?? [Number(controller.frequency)],
        sector_name: sector.name, type: sector.type, region: sector.region, is_ozserver: owners.has(controller.cid) };
    }).sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99) || a.sector_name.localeCompare(b.sector_name));
  });

  // A passthrough of VATSIM's AFV feed, which covers the live network only, so it takes no
  // ?server=. /map/controllers' non-live branch uses the sector's own frequency instead.
  app.get("/afv/transceivers", async () => afvTransceivers());

  // How much of the traffic in its airspace OzServer can see: every pilot in VATSIM's datafeed who
  // is inside one of the dataset's sectors (both FIRs and the oceanic sectors), and how many of
  // those have a recent flight record pushed by a controller's plugin. Live network only - the
  // datafeed does not cover a SweatBox.
  app.get("/map/traffic", async () => {
    const [pilots, polygons, records] = await Promise.all([
      vatsimData().then(data => data?.pilots ?? null),
      sectorPolygons(),
      pool.query("SELECT callsign FROM flight_data_records WHERE server='live' AND last_seen_at >= now()-($1*interval '1 minute')",
        [config.FDR_RETAIN_MINUTES])
    ]);
    const seen = new Set(records.rows.map(row => String(row.callsign).toUpperCase()));
    const inside = pilots ? pilotsInAirspace(pilots, polygons) : [];
    // And the same two counts for each region (regions.ts), for the homepage's per-region views.
    const regions: Record<string, { in_firs: number; seen_by_ozserver: number }> =
      Object.fromEntries(REGIONS.map(region => [region.value, { in_firs: 0, seen_by_ozserver: 0 }]));
    for (const pilot of inside) {
      const entry = regions[pilot.region] ??= { in_firs: 0, seen_by_ozserver: 0 };
      entry.in_firs++;
      if (seen.has(pilot.callsign)) entry.seen_by_ozserver++;
    }
    return {
      in_firs: inside.length,
      seen_by_ozserver: inside.filter(pilot => seen.has(pilot.callsign)).length,
      regions
    };
  });

  // Airborne traffic around one region from VATSIM's datafeed, for the homepage's decorative scope:
  // ?region= (regions.ts), Australia when left out. Every pilot in the area, OzServer or not,
  // trimmed to what a vatSys label shows: callsign and wake category, level, requested level,
  // groundspeed, destination - plus the heading the page dead-reckons with between refreshes.
  app.get<{ Querystring: { region?: string } }>("/map/pilots", async (request, reply) => {
    const box = PILOT_BOXES[request.query.region ?? "australia"];
    if (!box) return reply.code(400).send({ message: `region must be one of ${Object.keys(PILOT_BOXES).join(", ")}.` });
    const pilots = (await vatsimData())?.pilots ?? [];
    return pilots
      .filter(pilot => {
        const lon = box.eastward ? eastLon(pilot.longitude) : pilot.longitude;
        return pilot.latitude >= box.lat[0] && pilot.latitude <= box.lat[1] && lon >= box.lon[0] && lon <= box.lon[1];
      })
      .filter(pilot => pilot.groundspeed >= 50)
      .map(pilot => ({
        callsign: pilot.callsign,
        lat: pilot.latitude,
        lon: pilot.longitude,
        altitude: pilot.altitude,
        groundspeed: pilot.groundspeed,
        heading: pilot.heading,
        // ICAO-format aircraft field: "B738/M-SDE3FGHIRWY/LB1" - the wake category follows the type.
        wake: /^[A-Z0-9]{2,4}\/([LMHJ])/.exec(pilot.flight_plan?.aircraft ?? "")?.[1] ?? null,
        rfl: pilot.flight_plan?.altitude ?? null,
        arrival: pilot.flight_plan?.arrival || null
      }));
  });
}
