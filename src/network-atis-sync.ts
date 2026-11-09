import { transaction } from "./db.js";
import { publish } from "./events.js";
import { vatpacAtis } from "./network-atis.js";
import { vatsimData } from "./vatsim.js";

// Mirrors every VATPAC ATIS currently on the live VATSIM network into network_atis (see
// migrations/007_network_atis.sql), so the website can read it straight from our own API.
export async function syncNetworkAtis(): Promise<void> {
  const data = await vatsimData();
  // A failed or malformed fetch says nothing about who is connected. Leave the last good picture in
  // place rather than wiping the table - the next successful sync corrects it either way.
  if (!data || !Array.isArray(data.atis)) return;
  const feed = data.atis;

  const changed = await transaction(async client => {
    const datasetAirports = new Set((await client.query<{ icao: string }>(
      "SELECT DISTINCT asmgcs_airport AS icao FROM positions WHERE asmgcs_airport IS NOT NULL")).rows.map(row => row.icao));
    const stations = vatpacAtis(feed, datasetAirports);

    let count = 0;
    for (const atis of stations) {
      // The WHERE on the update is what makes the row count mean "something actually changed", so
      // a sync that found the same broadcasts as last time announces nothing.
      const result = await client.query(
        `INSERT INTO network_atis (callsign,icao,atis_code,frequency,text_atis,cid,name,logon_time,last_updated,synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (callsign) DO UPDATE SET icao=$2,atis_code=$3,frequency=$4,text_atis=$5,cid=$6,name=$7,
           logon_time=$8,last_updated=$9,synced_at=now()
         WHERE (network_atis.atis_code,network_atis.frequency,network_atis.text_atis,network_atis.cid)
           IS DISTINCT FROM ($3::varchar,$4::varchar,$5::text[],$6::integer)`,
        [atis.callsign, atis.icao, atis.atis_code, atis.frequency, atis.text_atis, atis.cid, atis.name,
          atis.logon_time, atis.last_updated]);
      count += result.rowCount ?? 0;
    }
    const removed = await client.query("DELETE FROM network_atis WHERE NOT (callsign=ANY($1))",
      [stations.map(atis => atis.callsign)]);
    return count + (removed.rowCount ?? 0) > 0;
  });

  // Network ATIS is live-network only by definition. Rides the existing "atis" signal so anything
  // already re-reading on it (the /ops map) picks this up too, instead of needing a new event type.
  if (changed) await publish({ type: "atis", server: "live" });
}
