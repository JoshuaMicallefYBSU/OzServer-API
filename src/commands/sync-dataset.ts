import { XMLParser } from "fast-xml-parser";
import { pool, transaction } from "../db.js";

const datasets = [
  "https://raw.githubusercontent.com/vatSys/australia-dataset/master/",
  "https://raw.githubusercontent.com/vatSys/pacific-dataset/master/"
];
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const csv = (value: unknown): string[] => typeof value === "string" ? value.split(",").map(item => item.trim()).filter(Boolean) : [];

function coordinate(raw: string): { lat: number; lon: number } {
  const match = raw.trim().match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid vatSys coordinate: ${raw}`);
  const component = (value: string) => {
    const sign = value.startsWith("-") ? -1 : 1;
    const unsigned = value.slice(1);
    const [whole = "0", fraction = "0"] = unsigned.split(".");
    if (whole.length <= 3) return sign * Number(unsigned);
    const seconds = Number(`${whole.slice(-2)}.${fraction}`);
    const minutes = Number(whole.slice(-4, -2));
    const degrees = Number(whole.slice(0, -4));
    return sign * (degrees + minutes / 60 + seconds / 3600);
  };
  return { lat: component(match[1]), lon: component(match[2]) };
}

async function xml(base: string, file: string): Promise<Record<string, any>> {
  const response = await fetch(base + file, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Dataset request failed: ${response.status} ${base}${file}`);
  return parser.parse(await response.text());
}

type Point = { lat: number; lon: number };

// How close (degrees, longitude scaled to ground distance) another boundary's corner has to be to an
// edge to be treated as lying on it - about 0.6 nm.
const SHARED_EDGE_TOLERANCE = 0.01;

// Makes neighbouring boundaries agree along the edges they share.
//
// The dataset describes each sector's boundary on its own, and two sectors either side of one line
// do not always list the same corners along it: KIMBERLEY turns at 13°55'04"S 128°26'12"E, while
// TERRITORY runs straight past that point to the start of its arc. Drawn as filled shapes, the
// space between the two versions of the line belongs to neither sector, and the map shows a sliver
// of nothing between them (Kununurra, east of Tasmania, Wollongong, Cape Leeuwin, ...). vatSys draws
// each boundary as a line on its own, so it never shows; a map of filled sectors does.
//
// Every corner of every boundary that lies on (within SHARED_EDGE_TOLERANCE of) another boundary's
// edge is added to that edge too, in order along it. Shared edges then have the same corners on both
// sides and the sliver closes. Nothing moves more than the tolerance, and these shapes are only ever
// drawn - nothing decides ownership from them (the plugin locates aircraft from vatSys's own data).
function shareEdgeCorners(rings: Point[][]): Point[][] {
  const corners = rings.flatMap((ring, ringIndex) => ring.map(point => ({ ...point, ringIndex })));
  return rings.map((ring, ringIndex) => {
    if (ring.length < 2) return ring;
    const out: Point[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!, b = ring[i + 1]!;
      out.push(a);
      const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
      const ax = a.lon * k, ay = a.lat, dx = b.lon * k - ax, dy = b.lat - ay;
      const length2 = dx * dx + dy * dy;
      if (length2 === 0) continue;
      const minLat = Math.min(a.lat, b.lat) - SHARED_EDGE_TOLERANCE, maxLat = Math.max(a.lat, b.lat) + SHARED_EDGE_TOLERANCE;
      const minLon = Math.min(a.lon, b.lon) - SHARED_EDGE_TOLERANCE / k, maxLon = Math.max(a.lon, b.lon) + SHARED_EDGE_TOLERANCE / k;
      const onEdge = new Map<string, { t: number; point: Point }>();
      for (const corner of corners) {
        if (corner.ringIndex === ringIndex || corner.lat < minLat || corner.lat > maxLat || corner.lon < minLon || corner.lon > maxLon) continue;
        const px = corner.lon * k, py = corner.lat;
        const t = ((px - ax) * dx + (py - ay) * dy) / length2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        if (Math.hypot(ax + t * dx - px, ay + t * dy - py) > SHARED_EDGE_TOLERANCE) continue;
        onEdge.set(`${corner.lat.toFixed(7)},${corner.lon.toFixed(7)}`, { t, point: { lat: corner.lat, lon: corner.lon } });
      }
      out.push(...[...onEdge.values()].sort((x, y) => x.t - y.t).map(entry => entry.point));
    }
    out.push(ring[ring.length - 1]!);
    return out;
  });
}

// Each dataset is resolved within itself: its sectors use its own volumes, and its volumes its own
// boundaries. The two datasets reuse names freely - the Pacific one has its own ARA, WIL, TSN, COL
// and more, with different geometry (its ARA is Arafura and Willis as one shape, for a sector it
// hides from the Sectors window). This used to keep one volume list keyed by name across both, so
// the Pacific ARA silently replaced the Australian one and the Australian ARA sector was drawn
// swallowing WIL.
//
// Which profile a sector comes from - Australian positions from the AUS profile, Pacific ones from
// the PAC profile. Each profile carries copies of its neighbour's sectors, and says which are its
// own by showing them in the Sectors window:
//
//  - the PAC profile shows only its own sectors (every Australian sector in it is hidden), so a
//    sector PAC shows is a Pacific one and comes from PAC - including the Pacific aerodrome and
//    approach positions the AUS profile also shows (AYNZA, AYPY ADC, NFFN ADC, NWWW ADC, ...);
//  - any other sector AUS shows is an Australian one and comes from AUS;
//  - one neither shows (KZAK, NZZO, WAAF, ...) is somebody else's airspace and is not imported.
type ParsedDataset = {
  profile: "AUS" | "PAC";
  boundaries: Map<string, Point[]>;
  volumes: Map<string, string[]>; // volume name -> boundary names
  sectors: Array<Record<string, any>>;
  shown: Map<string, Record<string, any>>; // sectors this profile shows in its Sectors window, by name
};
const parsed: ParsedDataset[] = [];
for (const [index, base] of datasets.entries()) {
  const volumesRoot = (await xml(base, "Volumes.xml")).Volumes;
  const sectorsRoot = (await xml(base, "Sectors.xml")).Sectors;
  const sectors = list<Record<string, any>>(sectorsRoot.Sector);
  parsed.push({
    profile: index === 0 ? "AUS" : "PAC",
    boundaries: new Map(list<Record<string, any>>(volumesRoot.Boundary).map(item => [String(item["@_Name"]),
      String(item["#text"] ?? "").split("/").filter(Boolean).map(coordinate)])),
    volumes: new Map(list<Record<string, any>>(volumesRoot.Volume).map(volume => [String(volume["@_Name"]), csv(volume.Boundaries)])),
    sectors,
    shown: new Map(sectors
      .filter(sector => String(sector["@_DisplayInSectorsWindow"] ?? "true").toLowerCase() !== "false")
      .map(sector => [String(sector["@_Name"]), sector]))
  });
}
const aus = parsed.find(dataset => dataset.profile === "AUS")!;
const pac = parsed.find(dataset => dataset.profile === "PAC")!;

const kept: Array<{ dataset: ParsedDataset; sector: Record<string, any>; boundaryNames: string[] }> = [];
const keep = (dataset: ParsedDataset, sector: Record<string, any>) => kept.push({
  dataset, sector, boundaryNames: csv(sector.Volumes).flatMap(volume => dataset.volumes.get(volume) ?? [])
});
for (const sector of pac.shown.values()) keep(pac, sector);
for (const [name, sector] of aus.shown) if (!pac.shown.has(name)) keep(aus, sector);

const fromPacAlsoInAus = [...pac.shown.keys()].filter(name => aus.shown.has(name));
console.log(`Sectors: ${kept.filter(k => k.dataset === aus).length} from AUS, ${kept.filter(k => k.dataset === pac).length} from PAC`
  + (fromPacAlsoInAus.length ? ` (shown in both, taken from PAC: ${fromPacAlsoInAus.join(", ")})` : ""));

// Shared edges matched across exactly the boundaries that will be drawn - not every boundary either
// file happens to contain, or a hidden duplicate's corners would be pulled into the real outlines.
const used = new Map<string, { dataset: ParsedDataset; name: string }>();
for (const { dataset, boundaryNames } of kept) {
  for (const name of boundaryNames) {
    if (dataset.boundaries.has(name)) used.set(`${dataset.profile}:${name}`, { dataset, name });
  }
}
const usedEntries = [...used.values()];
const matched = shareEdgeCorners(usedEntries.map(entry => entry.dataset.boundaries.get(entry.name)!));
usedEntries.forEach((entry, index) => entry.dataset.boundaries.set(entry.name, matched[index]!));

await transaction(async client => {
  await client.query("SELECT pg_advisory_xact_lock(684277)");
  const seenSectors: string[] = [];
  for (const { dataset, sector, boundaryNames } of kept) {
    const name = String(sector["@_Name"]);
    const callsign = sector["@_Callsign"] ? String(sector["@_Callsign"]) : null;
    const boundary = boundaryNames.flatMap(boundaryName => dataset.boundaries.has(boundaryName) ? [dataset.boundaries.get(boundaryName)] : []);
    await client.query(
      `INSERT INTO sectors (name,full_name,callsign,frequency,type,responsible_sectors,boundary,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT (name) DO UPDATE SET
       full_name=$2,callsign=$3,frequency=$4,type=$5,responsible_sectors=$6,
       boundary=CASE WHEN jsonb_array_length($7::jsonb)>0 THEN $7::jsonb ELSE sectors.boundary END,updated_at=now()`,
      [name, String(sector["@_FullName"] ?? ""), callsign, sector["@_Frequency"] ?? null,
        callsign?.split("_").at(-1) ?? null, JSON.stringify(csv(sector.ResponsibleSectors)), JSON.stringify(boundary)]);
    seenSectors.push(name);
  }
  // Deleting a sector cascades to whoever owns it right now, so this one statement can take live
  // ownership away from connected controllers. It should only ever do that for a sector the dataset
  // really dropped - not because a fetch came back with a different shape than this parser expects
  // and "every sector" suddenly reads as "a handful". A real release removes a few sectors at most;
  // losing more than a fifth of them in one sync is treated as a broken fetch and refused.
  const known = Number((await client.query("SELECT count(*) AS count FROM sectors")).rows[0].count);
  const surviving = Number((await client.query(
    "SELECT count(*) AS count FROM sectors WHERE name=ANY($1)", [seenSectors])).rows[0].count);
  if (known > 0 && surviving < known * 0.8) {
    throw new Error(`Refusing to sync: the dataset now lists only ${surviving} of the ${known} sectors already known.`);
  }
  await client.query("DELETE FROM sectors WHERE NOT (name=ANY($1))", [seenSectors]);

  // Positions likewise come from their own profile's Positions.xml. The two files share no position
  // names today; should one ever appear in both, it is not silently overwritten by whichever file is
  // read last - the PAC entry is taken if PAC shows a sector with that position's callsign prefix,
  // the AUS one otherwise, and the clash is reported.
  const seenPositions: string[] = [];
  const positionProfile = new Map<string, "AUS" | "PAC">();
  const pacPrefixes = new Set([...pac.shown.values()].map(sector => String(sector["@_Callsign"] ?? "").split(/[-_]/)[0]).filter(Boolean));
  for (const [index, base] of datasets.entries()) {
    const profile = index === 0 ? "AUS" : "PAC";
    const root = (await xml(base, "Positions.xml")).Positions;
    const candidates = [...list<Record<string, any>>(root.Position),
      ...list<Record<string, any>>(root.Group).flatMap(group => list<Record<string, any>>(group.Position))];
    for (const position of candidates) {
      const name = String(position["@_Name"]);
      const already = positionProfile.get(name);
      if (already) {
        const pacOwns = pacPrefixes.has(name.split(/[-_ ]/)[0] ?? "");
        console.warn(`Position ${name} is in both profiles; using ${pacOwns ? "PAC" : "AUS"}.`);
        if ((pacOwns ? "PAC" : "AUS") !== profile) continue;
      }
      positionProfile.set(name, profile);
      const center = coordinate(String(position["@_DefaultCenter"]));
      await client.query(
        `INSERT INTO positions (name,asmgcs_airport,default_lat,default_lon,updated_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (name) DO UPDATE SET asmgcs_airport=$2,default_lat=$3,default_lon=$4,updated_at=now()`,
        [name, position["@_ASMGCSAirport"] ?? null, center.lat, center.lon]);
      seenPositions.push(name);
    }
  }
  await client.query("DELETE FROM positions WHERE NOT (name=ANY($1))", [seenPositions]);
});

console.log("vatSys Australia and Pacific sector datasets synchronized.");
await pool.end();
