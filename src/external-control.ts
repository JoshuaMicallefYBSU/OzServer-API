import type pg from "pg";
import { config } from "./config.js";
import { pool } from "./db.js";
import { latestVatsimData } from "./vatsim.js";

// Airspace worked by a controller who is not running the OzServer plugin - ML-TBD_CTR connected
// through plain vatSys, extending onto Mundi's frequency, say. They never claim anything here, so on
// sector_ownerships alone OzServer would offer TBD and MUN to the next plugin user as free. Their
// sectors count as held instead ("external" holdings):
//
//  - Nobody can claim them: claimGroup treats each as a conflict with that controller, or withholds
//    it from a claim that only sweeps it up (routes/sectors.ts).
//  - Nobody can request them: there is no plugin on the other end to answer. The plugin explains
//    that coordination and tag handoffs have to be done by hand instead.
//  - Every plugin lists them as controlled, and the map shades them faintly.
//
// Nothing is stored as ownership. A holding exists only while it is worked out here, so it ends the
// moment the controller logs off or starts the plugin, with nothing to release.
//
// Where they come from
//
//  1. Their position: the sectors the plugins report for them (network_controllers, POST
//     /network/controllers), which a plugin works out from the profile's Positions.xml - this
//     server has no copy - and failing that the sector whose callsign is theirs.
//  2. What their controller information lines say they cover - "Extending MUN, GUN" (atisSectors)
//     - as a plugin's vatSys shows them, or on live VATSIM's datafeed.
//  3. Their frequencies, as the plugins see them in vatSys, and on the live network VATSIM's
//     datafeed and AFV's transceivers too (which is also how a controller nobody with the plugin
//     can see is found). Frequencies are reused across the country, so see frequencySectors for
//     which sector one means.
//
// What stays out: plugin users (plugin_clients), a sector a present OzServer controller holds, and
// anything a flow position could not hold (the FMP rule in routes/sectors.ts).

export type ExternalController = {
  callsign: string;
  // From VATSIM's datafeed on live. Unknown elsewhere: vatSys's controller list carries none.
  cid: number | null;
  real_name: string | null;
  frequencies: string[];
  sectors: string[];
};

export type ExternalHolding = { sector: string; callsign: string; cid: number | null };

export type ExternalHoldings = { controllers: ExternalController[]; holdings: Map<string, ExternalHolding> };

// A report counts for this long. Plugins report every 15 s and on every change they see, so a
// controller logging off drops out within a few reports' worth of silence.
export const NETWORK_REPORT_WINDOW_SECONDS = 45;

// The window sectors.ts reads plugin_clients with.
const PLUGIN_CLIENT_WINDOW_SECONDS = 15;

// What vatSys and VATSIM treat as a controller position. Observers, ATIS and pilots are not.
const CONTROLLER_CALLSIGN = /^\w[\w-]*_(FSS|CTR|APP|DEP|TWR|GND|DEL|RMP|TMU|FMP|RDO)$/i;

export function isControllerCallsign(callsign: string): boolean {
  return CONTROLLER_CALLSIGN.test(callsign);
}

// The kind of position a callsign suffix (or a sector's type, which is its callsign's suffix) is.
// A frequency only ever stands for a sector of the controller's own kind: an en-route controller on
// a tower's frequency is not working that tower.
const KIND: Record<string, string> = {
  CTR: "ENR", FSS: "ENR", APP: "TMA", DEP: "TMA", TWR: "ADC", GND: "ADC", DEL: "ADC", RMP: "ADC", FMP: "FMP"
};
const kindOf = (suffix: string | null | undefined) => (suffix ? KIND[suffix.toUpperCase()] : undefined);
const callsignKind = (callsign: string | null | undefined) => kindOf(callsign?.split("_").at(-1));

// The unit a callsign belongs to: "ML" for ML-TBD_CTR, "AF" for AF-N_TWR, "NWWW" for NWWW_APP.
const unitOf = (callsign: string | null | undefined) => callsign?.split("_")[0]?.split("-")[0]?.toUpperCase() ?? "";

// MHz to three decimals, whichever form it arrives in: MHz ("134.2"), kHz (134200), Hz (134200000)
// or FSD's offset from 100 MHz (34200). Null for anything that is not an airband channel - 199.998
// is an observer's "no frequency".
export function normaliseFrequency(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mhz = n >= 1e7 ? n / 1e6 : n >= 1e5 ? n / 1e3 : n >= 1e4 ? 100 + n / 1e3 : n;
  if (mhz < 108 || mhz >= 137) return null;
  return mhz.toFixed(3);
}

type SectorInfo = {
  name: string; full_name: string; callsign: string | null; type: string | null; frequency: string | null;
  // The middle of its boundary, for telling apart sectors that share a frequency. Null without one.
  centre: { lat: number; lon: number } | null;
  // How a controller's information lines name it (atisSectors), compiled once with the index.
  patterns: { name: RegExp; callsign: RegExp | null; fullName: RegExp | null };
};
type SectorIndex = { byName: Map<string, SectorInfo>; byFrequency: Map<string, SectorInfo[]> };

// The dataset changes only when sync-dataset runs, so it is read at most every ten minutes.
let sectorCache: { expires: number; value: Promise<SectorIndex> } | null = null;

function sectorIndex(): Promise<SectorIndex> {
  if (sectorCache && sectorCache.expires > Date.now()) return sectorCache.value;
  const value = (async () => {
    const rows = (await pool.query("SELECT name, full_name, callsign, type, frequency, boundary FROM sectors")).rows;
    const byName = new Map<string, SectorInfo>();
    const byFrequency = new Map<string, SectorInfo[]>();
    for (const row of rows) {
      const sector: SectorInfo = {
        name: row.name, full_name: row.full_name ?? "", callsign: row.callsign, type: row.type, frequency: row.frequency,
        centre: centreOf(row.boundary),
        patterns: {
          // As written in capitals, its space included ("BN SMC"); never part of a longer token.
          name: new RegExp(`(?<![A-Za-z0-9_-])${escapeRegex(row.name)}(?![A-Za-z0-9_-])`),
          callsign: row.callsign ? new RegExp(`(?<![A-Za-z0-9_-])${escapeRegex(row.callsign)}(?![A-Za-z0-9_-])`, "i") : null,
          // Any case ("Mundi"). Too short a full name would match ordinary words.
          fullName: String(row.full_name ?? "").trim().length >= 4
            ? new RegExp(`(?<![A-Za-z0-9])${escapeRegex(String(row.full_name).trim())}(?![A-Za-z0-9])`, "i") : null
        }
      };
      byName.set(sector.name, sector);
      const frequency = normaliseFrequency(sector.frequency);
      if (frequency) byFrequency.set(frequency, [...(byFrequency.get(frequency) ?? []), sector]);
    }
    return { byName, byFrequency };
  })();
  sectorCache = { expires: Date.now() + 10 * 60_000, value };
  value.catch(() => { sectorCache = null; });
  return value;
}

// Longitudes on 0-360, as map.ts does: the oceanic sectors run out past 180 degrees.
function centreOf(boundary: unknown): { lat: number; lon: number } | null {
  let lat = 0, lon = 0, count = 0;
  for (const ring of Array.isArray(boundary) ? boundary : []) {
    for (const point of Array.isArray(ring) ? ring : []) {
      const pLat = Number(point?.lat), pLon = Number(point?.lon);
      if (!Number.isFinite(pLat) || !Number.isFinite(pLon)) continue;
      lat += pLat;
      lon += pLon < 0 ? pLon + 360 : pLon;
      count++;
    }
  }
  return count ? { lat: lat / count, lon: lon / count } : null;
}

function distanceNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
}

// How far a sector a controller is extending onto can be from their own position. Generous for
// en-route airspace, and never far enough to reach the next unit reusing the frequency.
const MAX_EXTENSION_NM = 300;

// Which sectors a frequency a controller is on means. Frequencies are reused heavily - 118.100 is
// nine towers, 123.450 every flow position, 133.500 both Katoomba and Paraburdoo - so:
//
//  1. Only a sector of the controller's own kind (KIND): ENR, TMA, aerodrome or flow.
//  2. Of those, the ones in the controller's own unit (the ML of ML-TBD_CTR) if any are.
//  3. If that still leaves more than one, or none of them is in their unit, the one nearest the
//     controller's own position, within MAX_EXTENSION_NM. With no position to measure from, a
//     frequency that is still ambiguous means nothing.
function frequencySectors(callsign: string, frequency: string, index: SectorIndex, anchors: SectorInfo[]): SectorInfo[] {
  const kind = callsignKind(callsign);
  if (!kind) return [];
  const sameKind = (index.byFrequency.get(frequency) ?? []).filter(sector => kindOf(sector.type) === kind);
  const unit = unitOf(callsign);
  const sameUnit = sameKind.filter(sector => unitOf(sector.callsign) === unit);
  if (sameUnit.length === 1) return sameUnit;

  const candidates = sameUnit.length > 0 ? sameUnit : sameKind;
  const from = anchors.map(anchor => anchor.centre).filter((centre): centre is { lat: number; lon: number } => centre !== null);
  if (from.length === 0) return [];
  const measured = candidates
    .filter(sector => sector.centre !== null)
    .map(sector => ({ sector, distance: Math.min(...from.map(centre => distanceNm(centre, sector.centre!))) }))
    .filter(entry => entry.distance <= MAX_EXTENSION_NM)
    .sort((a, b) => a.distance - b.distance);
  return measured.length ? [measured[0]!.sector] : [];
}

// What a controller's information lines say they are covering besides their own position:
// "Extending MUN, GUN", "Also covering Mundi and Gundagai", "EXT ML-GUN_CTR". Only the text after
// one of these words is read, so a line that merely mentions a sector ("Contact BN SMC on 121.7")
// gives nothing.
const COVER_WORDS = /\b(?:extend(?:ing|ed|s)?|ext|cover(?:ing|s)?|combin(?:ed|ing)|incl(?:uding|udes)?|top[\s-]?down|band[\s-]?box(?:ed|ing)?|providing)\b/i;

// Sector names that are also words a controller types in capitals. Taken only from a line not
// written all in capitals, where a capitalised FOR is meant as the sector.
const COMMON_WORDS = new Set(["FOR", "NEW", "BAR"]);

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function atisSectors(lines: string[], callsign: string, index: SectorIndex): string[] {
  const found = new Set<string>();
  const unit = unitOf(callsign);
  for (const line of lines) {
    const cover = COVER_WORDS.exec(line);
    if (!cover) continue;
    const text = line.slice(cover.index + cover[0].length);
    const shouting = line === line.toUpperCase();

    for (const sector of index.byName.values()) {
      // By name, as written in capitals, or by callsign (ML-GUN_CTR).
      const byName = sector.patterns.name.test(text) && !(COMMON_WORDS.has(sector.name) && shouting);
      const byCallsign = sector.patterns.callsign?.test(text) ?? false;
      if (byName || byCallsign) found.add(sector.name);
    }

    // By full name. A full name several sectors share goes to the one in the controller's unit, or
    // to none; one that is only part of a longer one matched ("Sydney Tower" in "Sydney Tower
    // (East)") is that longer one.
    const byFullName = new Map<string, SectorInfo[]>();
    for (const sector of index.byName.values()) {
      if (!sector.patterns.fullName?.test(text)) continue;
      const key = sector.full_name.trim().toUpperCase();
      byFullName.set(key, [...(byFullName.get(key) ?? []), sector]);
    }
    const matchedNames = [...byFullName.keys()];
    for (const [key, sectors] of byFullName) {
      if (matchedNames.some(other => other !== key && other.includes(key))) continue;
      const chosen = sectors.length === 1 ? sectors : sectors.filter(sector => unitOf(sector.callsign) === unit);
      if (chosen.length === 1) found.add(chosen[0]!.name);
    }
  }
  return [...found];
}

// Worked out at most this often per server: every plugin's sync asks, every couple of seconds each.
const CACHE_MS = 2_000;
const cache = new Map<string, { expires: number; value: Promise<ExternalHoldings> }>();

// Drops the cached answer for a server, after something that changes it.
export function invalidateExternalHoldings(server: string): void {
  cache.delete(server);
}

export function externalHoldings(db: pg.Pool | pg.PoolClient, server: string): Promise<ExternalHoldings> {
  const hit = cache.get(server);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = computeExternalHoldings(db, server);
  cache.set(server, { expires: Date.now() + CACHE_MS, value });
  // A failure is not kept: the next caller tries again.
  value.catch(() => cache.delete(server));
  return value;
}

async function computeExternalHoldings(db: pg.Pool | pg.PoolClient, server: string): Promise<ExternalHoldings> {
  const index = await sectorIndex();
  const reported = await db.query(
    `SELECT callsign, real_name, frequencies, sectors, atis FROM network_controllers
      WHERE server=$1 AND last_seen_at >= now()-($2*interval '1 second')`,
    [server, NETWORK_REPORT_WINDOW_SECONDS]);
  const pluginUsers = await db.query(
    `SELECT DISTINCT upper(controller_callsign) AS callsign FROM plugin_clients
      WHERE server=$1 AND last_seen_at >= now()-($2*interval '1 second')`,
    [server, PLUGIN_CLIENT_WINDOW_SECONDS]);
  // Held by an OzServer controller who is still present. One who has gone quiet no longer blocks
  // a controller without the plugin who is working the sector now.
  const ownedRows = await db.query(
    `SELECT s.name, upper(o.controller_callsign) AS callsign FROM sector_ownerships o JOIN sectors s ON s.id=o.sector_id
      WHERE o.server=$1 AND o.last_seen_online_at >= now()-($2*interval '1 second')`,
    [server, config.PRESENCE_TIMEOUT_SECONDS]);

  const plugin = new Set<string>(pluginUsers.rows.map(row => String(row.callsign)));
  // A controller present on OzServer under this callsign runs the plugin, whether or not
  // plugin_clients has caught up.
  for (const row of ownedRows.rows) plugin.add(String(row.callsign));
  const owned = new Set<string>(ownedRows.rows.map(row => String(row.name)));

  const frequencies = (values: unknown[]) => [...new Set(values.map(normaliseFrequency).filter((f): f is string => f !== null))];
  // Their own position: as a plugin reported it, or the sector whose callsign is theirs.
  const ownPosition = (callsign: string, reportedSectors: string[]) => {
    const known = reportedSectors.filter(name => index.byName.has(name));
    return known.length ? known
      : [...index.byName.values()].filter(sector => sector.callsign?.toUpperCase() === callsign).map(sector => sector.name);
  };

  const controllers = new Map<string, ExternalController>();
  // Each controller's information lines (atisSectors), as a plugin's vatSys shows them.
  const infoLines = new Map<string, string[]>();
  for (const row of reported.rows) {
    const callsign = String(row.callsign).toUpperCase();
    if (plugin.has(callsign) || !isControllerCallsign(callsign)) continue;
    infoLines.set(callsign, stringArray(row.atis));
    controllers.set(callsign, {
      callsign,
      cid: null,
      real_name: row.real_name ?? null,
      frequencies: frequencies(stringArray(row.frequencies)),
      sectors: ownPosition(callsign, stringArray(row.sectors))
    });
  }

  if (server === "live") {
    // As last fetched: this runs inside claims, under the mutation lock.
    const { data, transceivers } = latestVatsimData();
    const afv = new Map(transceivers.map(entry => [entry.callsign.toUpperCase(), (entry.transceivers ?? []).map(t => t.frequency)]));
    for (const atc of data?.controllers ?? []) {
      const callsign = atc.callsign.toUpperCase();
      // Facility 0 is an observer.
      if (plugin.has(callsign) || !isControllerCallsign(callsign) || atc.facility === 0) continue;
      const entry = controllers.get(callsign) ?? {
        callsign, cid: null, real_name: atc.name ?? null, frequencies: [], sectors: ownPosition(callsign, [])
      };
      entry.cid = atc.cid;
      entry.frequencies = frequencies([...entry.frequencies, atc.frequency, ...(afv.get(callsign) ?? [])]);
      // The datafeed has their information lines too, for whoever no plugin can see.
      if (!infoLines.has(callsign)) infoLines.set(callsign, stringArray(atc.text_atis));
      controllers.set(callsign, entry);
    }
  }

  // Each controller's position, and the sectors their frequencies stand for (frequencySectors). A
  // sector two of them come to goes to the one logged on as it, otherwise to the first by callsign,
  // so every call gives the same answer.
  const holdings = new Map<string, ExternalHolding>();
  const ordered = [...controllers.values()].sort((a, b) => a.callsign.localeCompare(b.callsign));
  for (const controller of ordered) {
    // What their information lines say they cover ("Extending MUN, GUN") counts as theirs, like
    // their position, whatever its kind: they said so. Their frequencies fill in the rest.
    for (const name of atisSectors(infoLines.get(controller.callsign) ?? [], controller.callsign, index)) {
      if (!controller.sectors.includes(name)) controller.sectors.push(name);
    }
    const anchors = controller.sectors.map(name => index.byName.get(name)!);
    const names = new Set(controller.sectors);
    for (const frequency of controller.frequencies) {
      for (const sector of frequencySectors(controller.callsign, frequency, index, anchors)) names.add(sector.name);
    }
    for (const name of names) {
      const sector = index.byName.get(name);
      if (!sector || owned.has(name)) continue;
      // A flow position holds flow sectors only.
      if (callsignKind(controller.callsign) === "FMP" && kindOf(sector.type) !== "FMP") continue;
      if (holdings.has(name) && sector.callsign?.toUpperCase() !== controller.callsign) continue;
      holdings.set(name, { sector: name, callsign: controller.callsign, cid: controller.cid });
    }
  }
  for (const controller of ordered) {
    controller.sectors = [...holdings.values()].filter(h => h.callsign === controller.callsign).map(h => h.sector).sort();
  }

  return { controllers: ordered.filter(controller => controller.sectors.length > 0), holdings };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// What the holdings are, to tell whether a report changed anything worth announcing.
export function holdingsSignature(holdings: Map<string, ExternalHolding>): string {
  return [...holdings.values()].map(h => `${h.sector}>${h.callsign}`).sort().join("|");
}
