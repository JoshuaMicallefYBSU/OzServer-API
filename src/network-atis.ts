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
  // Always a letter: an entry without one is not mirrored at all (see vatpacAtis).
  atis_code: string;
  frequency: string;
  text_atis: string[];
  // The ATIS split into its sections, or - for a ZULU ATIS, which is free text with no sections -
  // the raw broadcast text as-is.
  content: AtisContent | string;
  // The sections this letter changed (vatSys's leading +), in editor order. Empty for a ZULU ATIS.
  changed: string[];
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
const tagPattern = /(?<marker>\+?)\[(?<name>[^\]]+)\]/g;
const normaliseTag = (tag: string) => tag.trim().toUpperCase().replace(/[\s_]+/g, " ");

// Every tag in the broadcast text, each paired with the slice of text it owns: from the end of the
// tag up to the next tag of any kind (including MODE etc., which are not sections we serve), so a
// section the text wraps across several lines still comes out whole. `section` is null for a tag
// that is not one of ATIS_SECTIONS, and `changed` is vatSys's leading + marker.
function atisTags(text: string) {
  const tags = [...text.matchAll(tagPattern)];
  return tags.map((tag, index) => ({
    section: ATIS_SECTIONS.find(name => name === normaliseTag(tag.groups?.name ?? "")) ?? null,
    changed: tag.groups?.marker === "+",
    value: text.slice((tag.index ?? 0) + tag[0].length, tags[index + 1]?.index ?? text.length).replace(/\s+/g, " ").trim()
  }));
}

// Splits the broadcast's text into its sections. A section missing from the text - or present but
// empty - is null.
export function atisContent(lines: readonly string[]): AtisContent {
  const content = Object.fromEntries(ATIS_SECTIONS.map(section => [section, null])) as AtisContent;
  for (const tag of atisTags(lines.join(" "))) {
    if (tag.section) content[tag.section] = tag.value || null;
  }
  return content;
}

// The sections this letter changed since the previous one - the ones vatSys marked with a leading
// + ("+[RWY] 34"). Listed in the order the sections appear in the ATIS editor rather than the order
// the text happens to use, and deduplicated, so a consumer can compare the array directly.
export function atisChanges(lines: readonly string[]): string[] {
  const changed = new Set(atisTags(lines.join(" ")).filter(tag => tag.changed && tag.section).map(tag => tag.section));
  return ATIS_SECTIONS.filter(section => changed.has(section));
}

// A day-time group as aviation writes it - DDHHMMz, e.g. 110615z for the 11th at 0615 UTC - which
// is how an ATIS timestamp is read and spoken, rather than an ISO instant.
export function atisTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}z`;
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
    // No letter means there is no broadcast to mirror yet - a station that has connected but not
    // published an ATIS. Dropping it here rather than storing a letterless, all-null row keeps
    // "a row exists" and "there is an ATIS" the same statement for every consumer, and the sync's
    // own delete sweep removes the row again if a connected station's letter goes away.
    if (!code || code.length !== 1) continue;
    const textAtis = (entry.text_atis ?? []).filter(line => typeof line === "string");
    result.set(callsign, {
      callsign,
      icao,
      atis_code: code,
      frequency: String(entry.frequency),
      text_atis: textAtis,
      content: code === "Z" ? textAtis.join(" ").trim() : atisContent(textAtis),
      // A ZULU ATIS has no sections, so nothing to mark as changed.
      changed: code === "Z" ? [] : atisChanges(textAtis),
      cid: Number(entry.cid),
      name: entry.name ?? null,
      logon_time: entry.logon_time ?? null,
      last_updated: entry.last_updated ?? null
    });
  }
  return [...result.values()];
}
