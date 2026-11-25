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
// How long the last feed that did arrive stands in for one that did not. A single failed fetch
// used to empty the cache: for the next fifteen seconds no controller known only from the feed
// held anything (external-control.ts), so their airspace could be claimed unasked, and the map
// showed every sector offline. Long enough to ride out a slow or failing VATSIM, short enough
// that a controller who has logged off does not stay listed.
const STALE_MS = 2 * 60_000;
let dataCache: { expires: number; value: VatsimData | null; fetchedAt: number } = { expires: 0, value: null, fetchedAt: 0 };
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

// The feed that last arrived, while it is recent enough to stand in.
function recentData(): VatsimData | null {
  return dataCache.value !== null && Date.now() - dataCache.fetchedAt < STALE_MS ? dataCache.value : null;
}

export async function vatsimData(): Promise<VatsimData | null> {
  if (dataCache.expires > Date.now()) return dataCache.value;
  dataRefresh ??= (async () => {
    const status = await getJson<{ data?: { v3?: string[] } }>("https://status.vatsim.net/status.json");
    const url = status?.data?.v3?.[0];
    const value = url ? await getJson<VatsimData>(url) : null;
    // A failed fetch keeps the last good feed while it is recent, and is retried no sooner than
    // the next window.
    dataCache = value !== null
      ? { expires: Date.now() + CACHE_MS, value, fetchedAt: Date.now() }
      : { expires: Date.now() + CACHE_MS, value: recentData(), fetchedAt: dataCache.fetchedAt };
    return dataCache.value;
  })().finally(() => { dataRefresh = null; });
  // Nobody waits on VATSIM while there is a recent feed to answer with: a refresh can take twenty
  // seconds when VATSIM is slow, and every map request would otherwise queue behind it. getJson
  // never rejects, so the refresh left running cannot fail unobserved.
  return recentData() ?? dataRefresh;
}

// The feeds as last fetched, without waiting for a refresh (which is started if one is due). For
// work done holding the sector-mutation lock, which must not wait on VATSIM for up to 20 s.
export function latestVatsimData(): { data: VatsimData | null; transceivers: TransceiverEntry[] } {
  if (dataCache.expires <= Date.now()) void vatsimData();
  if (transceiverCache.expires <= Date.now()) void afvTransceivers();
  return { data: recentData(), transceivers: transceiverCache.value };
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
