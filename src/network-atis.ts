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
  cid: number;
  name: string | null;
  logon_time: string | null;
  last_updated: string | null;
};

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
    result.set(callsign, {
      callsign,
      icao,
      atis_code: code && code.length === 1 ? code : null,
      frequency: String(entry.frequency),
      text_atis: (entry.text_atis ?? []).filter(line => typeof line === "string"),
      cid: Number(entry.cid),
      name: entry.name ?? null,
      logon_time: entry.logon_time ?? null,
      last_updated: entry.last_updated ?? null
    });
  }
  return [...result.values()];
}
