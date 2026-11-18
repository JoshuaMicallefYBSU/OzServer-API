// Live network stats in a Discord channel: a few embeds, posted once and then edited in place every
// LIVE_STATS_INTERVAL_SECONDS, so the channel always shows the network as it is now.
//
//   controllers - every Australian controller on VATSIM, whether they run OzServer, what they are
//                 extending into, and the tags they track.
//   fir_tags    - the aircraft OzServer clients are reporting, by FIR, tracked and untracked.
//
// Live network only: SweatBox sessions are training, not "the network currently".
//
// The message ids are kept in discord_live_messages, so a restart edits the same messages. A message
// deleted from the channel is posted again. DISCORD_LIVE_MESSAGE_IDS adopts messages posted by hand
// before this ran. The webhook URL is a credential (see discord.ts) and is never logged.
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { pool } from "./db.js";
import {
  ancestorsOf, controllersEmbed, firResolver, firTagsEmbed, parentMap, PLUGIN_RECENT_MINUTES, RECENT_MINUTES,
  REQUEST_TIMEOUT_MS, sortFirs, TYPE_PRIORITY,
  type ControllerStat, type Embed, type FirStat, type SectorRow
} from "./live-stats-format.js";
import { vatsimData } from "./vatsim.js";

async function collect(): Promise<{ controllers: ControllerStat[]; firs: FirStat[] }> {
  const [sectorRows, ownershipRows, flightRows, pluginRows, feed] = await Promise.all([
    pool.query<SectorRow>("SELECT name,callsign,type,frequency,responsible_sectors FROM sectors"),
    pool.query<{ name: string; controller_callsign: string }>(
      `SELECT s.name,o.controller_callsign FROM sector_ownerships o JOIN sectors s ON s.id=o.sector_id
        WHERE o.server='live'`),
    pool.query<{ callsign: string; controlling_callsign: string | null; current_sector: string | null;
      tracked_by: string | null; state: string | null }>(
      `SELECT callsign,controlling_callsign,current_sector,data->>'tracked_by' AS tracked_by,data->>'state' AS state
         FROM flight_data_records
        WHERE server='live' AND last_seen_at >= now()-($1*interval '1 minute')
        ORDER BY callsign`, [RECENT_MINUTES]),
    pool.query<{ controller_callsign: string }>(
      `SELECT DISTINCT controller_callsign FROM plugin_clients
        WHERE server='live' AND last_seen_at >= now()-($1*interval '1 minute')`, [PLUGIN_RECENT_MINUTES]),
    vatsimData()
  ]);

  const sectors = sectorRows.rows;
  const fir = firResolver(sectors);
  const parents = parentMap(sectors);
  const sectorByCallsign = new Map<string, SectorRow>();
  for (const sector of sectors) {
    if (sector.callsign && !sectorByCallsign.has(sector.callsign.toUpperCase())) {
      sectorByCallsign.set(sector.callsign.toUpperCase(), sector);
    }
  }

  const ownedBy = new Map<string, string[]>();
  for (const row of ownershipRows.rows) {
    const key = row.controller_callsign.toUpperCase();
    const list = ownedBy.get(key) ?? [];
    list.push(row.name);
    ownedBy.set(key, list);
  }
  const pluginCallsigns = new Set(pluginRows.rows.map(row => row.controller_callsign.toUpperCase()));

  const flights = flightRows.rows.filter(row => row.state !== "STATE_FINISHED");
  const tracker = (flight: typeof flights[number]) => (flight.tracked_by || flight.controlling_callsign || "").toUpperCase();

  // Australian controllers on the feed - those whose callsign is a dataset sector's - plus anyone
  // calling OzServer the feed has not caught up with yet (it lags a connection by tens of seconds).
  const online = new Map<string, string | null>();
  for (const controller of feed?.controllers ?? []) {
    const key = controller.callsign.toUpperCase();
    if (sectorByCallsign.has(key)) online.set(key, controller.frequency ?? null);
  }
  for (const callsign of pluginCallsigns) {
    if (!online.has(callsign) && sectorByCallsign.has(callsign)) online.set(callsign, null);
  }

  const controllers: ControllerStat[] = [...online].map(([callsign, feedFrequency]) => {
    const home = sectorByCallsign.get(callsign) ?? null;
    const owned = ownedBy.get(callsign) ?? [];
    const ownedSet = new Set(owned);
    // What they hold beyond their own position: the top of each owned group other than their own.
    const extending = owned
      .filter(name => name !== home?.name)
      .filter(name => ![...ancestorsOf(name, parents)].some(ancestor => ownedSet.has(ancestor)))
      .sort();
    return {
      callsign,
      sector: home?.name ?? null,
      type: home?.type ?? null,
      frequency: home?.frequency ?? feedFrequency,
      onOzServer: pluginCallsigns.has(callsign) || owned.length > 0,
      extending,
      tags: flights.filter(flight => tracker(flight) === callsign).map(flight => flight.callsign)
    };
  }).sort((a, b) => (TYPE_PRIORITY[a.type ?? ""] ?? 99) - (TYPE_PRIORITY[b.type ?? ""] ?? 99)
    || a.callsign.localeCompare(b.callsign));

  const byFir = new Map<string, FirStat>();
  for (const flight of flights) {
    const name = fir(flight.current_sector);
    const entry = byFir.get(name) ?? { fir: name, tracked: [], untracked: [] };
    const by = tracker(flight);
    if (by) entry.tracked.push({ callsign: flight.callsign, by });
    else entry.untracked.push(flight.callsign);
    byFir.set(name, entry);
  }
  return { controllers, firs: sortFirs([...byFir.values()]) };
}

type Delivery = { ok: true; id: string } | { ok: false; gone: boolean; status: number };

async function deliver(url: string, messageId: string | null, embed: Embed): Promise<Delivery> {
  const body = JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } });
  const headers = { "Content-Type": "application/json" };
  const response = messageId
    ? await fetch(`${url}/messages/${messageId}`, { method: "PATCH", headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    : await fetch(`${url}?wait=true`, { method: "POST", headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) return { ok: false, gone: response.status === 404, status: response.status };
  const sent = await response.json() as { id?: unknown };
  return typeof sent.id === "string" ? { ok: true, id: sent.id } : { ok: false, gone: false, status: response.status };
}

async function storedId(key: string): Promise<string | null> {
  const row = (await pool.query<{ message_id: string }>(
    "SELECT message_id FROM discord_live_messages WHERE key=$1", [key])).rows[0];
  return row?.message_id ?? config.DISCORD_LIVE_MESSAGE_IDS.get(key) ?? null;
}

async function storeId(key: string, messageId: string): Promise<void> {
  await pool.query(
    `INSERT INTO discord_live_messages (key,message_id,updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET message_id=$2,updated_at=now()`, [key, messageId]);
}

async function publishEmbed(url: string, key: string, embed: Embed, log: FastifyBaseLogger): Promise<void> {
  const existing = await storedId(key);
  let result = await deliver(url, existing, embed);
  // Deleted from the channel (or an adopted id that was never this webhook's): posted afresh.
  if (!result.ok && result.gone && existing) result = await deliver(url, null, embed);
  if (!result.ok) {
    log.warn({ key, status: result.status }, "Could not update a live stats message in Discord.");
    return;
  }
  if (result.id !== existing) {
    await storeId(key, result.id);
    log.info({ key, messageId: result.id }, "Posted a live stats message to Discord.");
  } else if (existing && !(await pool.query("SELECT 1 FROM discord_live_messages WHERE key=$1", [key])).rowCount) {
    // Adopted from DISCORD_LIVE_MESSAGE_IDS: recorded, so the setting can be removed.
    await storeId(key, existing);
  }
}

let running = false;

export async function runLiveStats(log: FastifyBaseLogger): Promise<void> {
  const url = config.DISCORD_LIVE_WEBHOOK_URL;
  if (!url || running) return;
  running = true;
  try {
    const now = new Date();
    const { controllers, firs } = await collect();
    // One after another, in channel order: a first run posts them top to bottom.
    await publishEmbed(url, "controllers", controllersEmbed(controllers, now), log);
    await publishEmbed(url, "fir_tags", firTagsEmbed(firs, now), log);
  } finally {
    running = false;
  }
}

export function startLiveStats(log: FastifyBaseLogger): NodeJS.Timeout | null {
  if (!config.DISCORD_LIVE_WEBHOOK_URL) return null;
  const tick = () => void runLiveStats(log).catch(error => log.warn(error, "Live stats update failed."));
  // Shortly after start-up rather than at once: the first VATSIM fetch and the pool are warming up.
  setTimeout(tick, 5_000).unref();
  const timer = setInterval(tick, config.LIVE_STATS_INTERVAL_SECONDS * 1000);
  timer.unref();
  return timer;
}
