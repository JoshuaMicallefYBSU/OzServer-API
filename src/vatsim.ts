// VATSIM's public datafeed, for the public map (routes/map.ts) only: the map has to show every
// controller and aircraft on the network, plugin user or not.
//
// And for the controllers without the plugin whose airspace counts as held (external-control.ts),
// which only adds to what the plugins themselves report.
//
// Do not use this to decide whether a controller OzServer tracks is still connected. The feed is
// cached here for 15 s on top of VATSIM's own publish interval and lags a real connection by tens
// of seconds in both directions. Sector ownership, FDR authority and disconnect handling use
// sector_ownerships.last_seen_online_at, which the heartbeat in app.ts keeps current.

// facility 0 is an observer, and logon_time (ISO 8601) is when this connection began (see
// external-control.ts).
type Controller = {
  cid: number; callsign: string; frequency?: string; name?: string; facility?: number; text_atis?: string[] | null; logon_time?: string;
};
export type Pilot = {
  callsign: string; latitude: number; longitude: number; altitude: number; groundspeed: number; heading: number;
  flight_plan?: { aircraft?: string; aircraft_short?: string; altitude?: string; arrival?: string } | null;
};
// `atis` is every connected ATIS station - read only for whether one is on the network at all
// (routes/map.ts), never for its text, which the plugin publishes directly.
type VatsimData = { controllers?: Controller[]; pilots?: Pilot[]; atis?: Array<{ callsign: string }> };
type TransceiverEntry = { callsign: string; transceivers?: Array<{ frequency: number }> };

const CACHE_MS = 15_000;
let dataCache: { expires: number; value: VatsimData | null } = { expires: 0, value: null };
let transceiverCache: { expires: number; value: TransceiverEntry[] } = { expires: 0, value: [] };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() as T : null;
  } catch {
    return null;
  }
}

// One fetch per feed at a time: callers arriving during a refresh wait on the same request, so a
// busy map does not multiply requests to VATSIM.
let dataRefresh: Promise<VatsimData | null> | null = null;
let transceiverRefresh: Promise<TransceiverEntry[]> | null = null;

export async function vatsimData(): Promise<VatsimData | null> {
  if (dataCache.expires > Date.now()) return dataCache.value;
  dataRefresh ??= (async () => {
    const status = await getJson<{ data?: { v3?: string[] } }>("https://status.vatsim.net/status.json");
    const url = status?.data?.v3?.[0];
    const value = url ? await getJson<VatsimData>(url) : null;
    dataCache = { expires: Date.now() + CACHE_MS, value };
    return value;
  })().finally(() => { dataRefresh = null; });
  return dataRefresh;
}

// The feeds as last fetched, without waiting for a refresh (which is started if one is due). For
// work done holding the sector-mutation lock, which must not wait on VATSIM for up to 20 s.
export function latestVatsimData(): { data: VatsimData | null; transceivers: TransceiverEntry[] } {
  if (dataCache.expires <= Date.now()) void vatsimData();
  if (transceiverCache.expires <= Date.now()) void afvTransceivers();
  return { data: dataCache.value, transceivers: transceiverCache.value };
}

export async function afvTransceivers(): Promise<TransceiverEntry[]> {
  if (transceiverCache.expires > Date.now()) return transceiverCache.value;
  transceiverRefresh ??= (async () => {
    const value = await getJson<TransceiverEntry[]>("https://data.vatsim.net/v3/transceivers-data.json");
    // A failed fetch keeps the last good list, and is retried no sooner than the next window.
    transceiverCache = { expires: Date.now() + CACHE_MS, value: value ?? transceiverCache.value };
    return transceiverCache.value;
  })().finally(() => { transceiverRefresh = null; });
  return transceiverRefresh;
}
