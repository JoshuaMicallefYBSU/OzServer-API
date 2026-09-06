// VATSIM's own public view of the network - for the public map (mapRoutes) only, which has to show
// every controller and aircraft on the network, plugin user or not, and has no other way to do that.
//
// Nothing about our own sector ownership, FDR authority or disconnect handling reads this module any
// more. Those all concern a controller this server already has a direct, continuous relationship
// with - one running this plugin, whose every request already proves they're there - and routing
// that question through this feed instead cost real accuracy for no benefit: it is fetched here
// through a 15s cache stacked on top of VATSIM's own publish interval, and it lags a real connection
// by tens of seconds in both directions. A controller who had just claimed sectors could look absent
// from it for the better part of a minute (flights.ts, maintenance.ts, and claimGroup's staffed-
// conflict check all hit exactly that lag at one point or another); it was never faster or more
// accurate than last_seen_online_at, which our own claim/accept/resume/request-accept handlers and
// the request heartbeat in app.ts already keep current in real time. If you're tempted to reach for
// this module to answer "is controller X still around" for something OzServer already tracks
// ownership of, don't - that question belongs to sector_ownerships.last_seen_online_at instead.
type Controller = { cid: number; callsign: string; frequency?: string };
type VatsimData = { controllers?: Controller[] };
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

export async function vatsimData(): Promise<VatsimData | null> {
  if (dataCache.expires > Date.now()) return dataCache.value;
  const status = await getJson<{ data?: { v3?: string[] } }>("https://status.vatsim.net/status.json");
  const url = status?.data?.v3?.[0];
  const value = url ? await getJson<VatsimData>(url) : null;
  dataCache = { expires: Date.now() + CACHE_MS, value };
  return value;
}

export async function afvTransceivers(): Promise<TransceiverEntry[]> {
  if (transceiverCache.expires > Date.now()) return transceiverCache.value;
  const value = await getJson<TransceiverEntry[]>("https://data.vatsim.net/v3/transceivers-data.json");
  if (value) transceiverCache = { expires: Date.now() + CACHE_MS, value };
  return transceiverCache.value;
}
