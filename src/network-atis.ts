// Pure parsing/filtering for the VATSIM datafeed's `atis` array - kept free of any database import
// so it can be unit tested without a DATABASE_URL. The sync itself is in network-atis-sync.ts.

// One entry of the datafeed's top-level `atis` array (https://data.vatsim.net/v3/vatsim-data.json).
export type VatsimAtis = {
  cid: number;
  name?: string;
  callsign: string;
  frequency: string;
  atis_code?: string | null;
  text_atis?: string[] | null;
  logon_time?: string;
  last_updated?: string;
};

export type NetworkAtis = {
  callsign: string;
  icao: string;
  atis_code: string | null;
  frequency: string;
  text_atis: string[];
  content: AtisContent;
  cid: number;
  name: string | null;
  logon_time: string | null;
  last_updated: string | null;
};

// The sections of a vatSys ATIS (as laid out in the ATIS editor) that the API serves. MODE,
// OFCW_NOTIFY and TIME_CHECK are editor settings rather than broadcast information, so they are
// left out even when the text carries them.
export const ATIS_SECTIONS = ["APCH", "RWY", "SFC COND", "OPR INFO", "WIND", "VIS", "WX", "CLD", "TMP", "QNH", "SIGWX"] as const;
export type AtisContent = Record<typeof ATIS_SECTIONS[number], string | null>;

// "[RWY] 34" or "+[APCH] ..." - the leading + is how vatSys marks a section changed since the
// previous letter, so it belongs to the tag, not to the previous section's value.
const tagPattern = /\+?\[([^\]]+)\]/g;
const normaliseTag = (tag: string) => tag.trim().toUpperCase().replace(/[\s_]+/g, " ");

// Splits the broadcast's text into its sections. Each section's value runs from its tag up to the
// next tag of any kind (including MODE etc., which are then dropped), so a section the text wraps
// across several lines still comes out whole. A section missing from the text - or present but
// empty - is null.
export function atisContent(lines: readonly string[]): AtisContent {
  const content = Object.fromEntries(ATIS_SECTIONS.map(section => [section, null])) as AtisContent;
  const text = lines.join(" ");
  const tags = [...text.matchAll(tagPattern)];
  tags.forEach((tag, index) => {
    const section = ATIS_SECTIONS.find(name => name === normaliseTag(tag[1] ?? ""));
    if (!section) return;
    const end = tags[index + 1]?.index ?? text.length;
    const value = text.slice((tag.index ?? 0) + tag[0].length, end).replace(/\s+/g, " ").trim();
    content[section] = value || null;
  });
  return content;
}

// YSSY_ATIS, and the less common suffixed forms like YSSY_D_ATIS (departure) or YSSY_A_ATIS.
const callsignPattern = /^([A-Z]{4})(?:_[A-Z0-9]+)?_ATIS$/;

export function atisIcao(callsign: string): string | null {
  return callsignPattern.exec(callsign.trim().toUpperCase())?.[1] ?? null;
}

// VATPAC's airports are Australia's (every Australian ICAO starts with Y), plus anything else the
// vatSys dataset itself defines an aerodrome position for - passed in as `datasetAirports` - so an
// airport VATPAC adds to its profile is picked up by the next dataset sync without a code change.
export function isVatpacAirport(icao: string, datasetAirports: ReadonlySet<string>): boolean {
  return icao.startsWith("Y") || datasetAirports.has(icao);
}

export function vatpacAtis(entries: readonly VatsimAtis[], datasetAirports: ReadonlySet<string>): NetworkAtis[] {
  const result = new Map<string, NetworkAtis>();
  for (const entry of entries) {
    if (typeof entry?.callsign !== "string") continue;
    const icao = atisIcao(entry.callsign);
    if (!icao || !isVatpacAirport(icao, datasetAirports)) continue;
    const callsign = entry.callsign.trim().toUpperCase();
    const code = entry.atis_code?.trim().toUpperCase();
    const textAtis = (entry.text_atis ?? []).filter(line => typeof line === "string");
    result.set(callsign, {
      callsign,
      icao,
      atis_code: code && code.length === 1 ? code : null,
      frequency: String(entry.frequency),
      text_atis: textAtis,
      content: atisContent(textAtis),
      cid: Number(entry.cid),
      name: entry.name ?? null,
      logon_time: entry.logon_time ?? null,
      last_updated: entry.last_updated ?? null
    });
  }
  return [...result.values()];
}
