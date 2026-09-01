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

export async function onlineControllers(): Promise<Map<string, number> | null> {
  const data = await vatsimData();
  if (!data?.controllers) return null;
  return new Map(data.controllers.map(controller => [controller.callsign.toUpperCase(), controller.cid]));
}

export async function afvTransceivers(): Promise<TransceiverEntry[]> {
  if (transceiverCache.expires > Date.now()) return transceiverCache.value;
  const value = await getJson<TransceiverEntry[]>("https://data.vatsim.net/v3/transceivers-data.json");
  if (value) transceiverCache = { expires: Date.now() + CACHE_MS, value };
  return transceiverCache.value;
}
