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

const volumes = new Map<string, unknown[]>();
for (const base of datasets) {
  const root = (await xml(base, "Volumes.xml")).Volumes;
  const boundaries = new Map(list<Record<string, any>>(root.Boundary).map(item => [item["@_Name"],
    String(item["#text"] ?? "").split("/").filter(Boolean).map(coordinate)]));
  for (const volume of list<Record<string, any>>(root.Volume)) {
    volumes.set(volume["@_Name"], csv(volume.Boundaries).flatMap(name => boundaries.get(name) ? [boundaries.get(name)] : []));
  }
}

await transaction(async client => {
  await client.query("SELECT pg_advisory_xact_lock(684277)");
  const seenSectors: string[] = [];
  for (const base of datasets) {
    const root = (await xml(base, "Sectors.xml")).Sectors;
    for (const sector of list<Record<string, any>>(root.Sector)) {
      if (String(sector["@_DisplayInSectorsWindow"] ?? "true").toLowerCase() === "false") continue;
      const name = String(sector["@_Name"]);
      const callsign = sector["@_Callsign"] ? String(sector["@_Callsign"]) : null;
      const volumeNames = csv(sector.Volumes);
      const boundary = volumeNames.flatMap(volume => volumes.get(volume) ?? []);
      await client.query(
        `INSERT INTO sectors (name,full_name,callsign,frequency,type,responsible_sectors,boundary,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT (name) DO UPDATE SET
         full_name=$2,callsign=$3,frequency=$4,type=$5,responsible_sectors=$6,
         boundary=CASE WHEN jsonb_array_length($7::jsonb)>0 THEN $7::jsonb ELSE sectors.boundary END,updated_at=now()`,
        [name, String(sector["@_FullName"] ?? ""), callsign, sector["@_Frequency"] ?? null,
          callsign?.split("_").at(-1) ?? null, JSON.stringify(csv(sector.ResponsibleSectors)), JSON.stringify(boundary)]);
      seenSectors.push(name);
    }
  }
  await client.query("DELETE FROM sectors WHERE NOT (name=ANY($1))", [seenSectors]);

  const seenPositions: string[] = [];
  for (const base of datasets) {
    const root = (await xml(base, "Positions.xml")).Positions;
    const candidates = [...list<Record<string, any>>(root.Position),
      ...list<Record<string, any>>(root.Group).flatMap(group => list<Record<string, any>>(group.Position))];
    for (const position of candidates) {
      const name = String(position["@_Name"]);
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
