import { config } from "./config.js";
import { transaction } from "./db.js";
import { publish } from "./events.js";
import { reassignFreedSectors } from "./grouping.js";
import { onlineControllers } from "./vatsim.js";

export async function runMaintenance(): Promise<void> {
  const online = await onlineControllers();
  // A VATSIM outage must never be interpreted as every controller disconnecting.
  if (online === null) return;
  const releasedAny = await transaction(async client => {
    let released = false;
    // Collected across every disconnected controller and handled after the loop: reassigning while
    // other rows are still being deleted could hand a sub-sector to a controller who is, one
    // iteration later, found to have dropped off as well.
    const freed: string[] = [];
    const owners = (await client.query(
      "SELECT DISTINCT controller_cid,controller_callsign FROM sector_ownerships")).rows;
    for (const owner of owners) {
      if (online.get(owner.controller_callsign.toUpperCase()) === owner.controller_cid) {
        await client.query(
          "UPDATE sector_ownerships SET last_seen_online_at=now() WHERE controller_cid=$1 AND controller_callsign=$2",
          [owner.controller_cid, owner.controller_callsign]);
        continue;
      }
      const removed = await client.query(
        `DELETE FROM sector_ownerships WHERE controller_cid=$1 AND controller_callsign=$2
          AND last_seen_online_at <= now()-($3*interval '1 minute') RETURNING sector_id`,
        [owner.controller_cid, owner.controller_callsign, config.DISCONNECT_GRACE_MINUTES]);
      if (!removed.rowCount) continue;
      released = true;
      freed.push(...removed.rows.map(row => row.sector_id));
      await client.query("DELETE FROM sector_requests WHERE sector_id=ANY($1)", [removed.rows.map(row => row.sector_id)]);
      const remains = await client.query("SELECT 1 FROM sector_ownerships WHERE controller_cid=$1 LIMIT 1", [owner.controller_cid]);
      if (!remains.rowCount) await client.query(
        "UPDATE flight_data_records SET controlling_cid=NULL,controlling_callsign=NULL WHERE controlling_cid=$1", [owner.controller_cid]);
    }
    // Every disconnected controller's rows are gone by now, so a sub-sector left behind can be
    // handed to whoever is still working the group above it.
    await reassignFreedSectors(client, freed);
    await client.query(`DELETE FROM flight_data_records WHERE last_seen_at < now()-($1*interval '1 minute')`, [config.FDR_RETAIN_MINUTES]);
    await client.query(`DELETE FROM atis_broadcasts WHERE last_seen_at < now()-($1*interval '1 minute')`, [config.ATIS_RETAIN_MINUTES]);
    await client.query("DELETE FROM sector_requests WHERE rejected_at < now()-interval '1 day'");
    // Kept for a day. Long enough to look into something reported the next morning, short enough
    // that a busy evening's worth of every controller's logs is not accumulated indefinitely.
    await client.query("DELETE FROM client_logs WHERE logged_at < now()-interval '1 day'");
    // Shared notes and drawings outlive a momentary drop but not a sign-off, on the same grace the
    // sectors above use. Keyed off last_seen_online_at, which every read by the author refreshes -
    // so this only ever catches a controller whose client has actually stopped calling.
    await client.query(
      "DELETE FROM annotations WHERE last_seen_online_at < now()-($1*interval '1 minute')",
      [config.DISCONNECT_GRACE_MINUTES]);
    await client.query("DELETE FROM resume_snapshots WHERE created_at < now()-($1*interval '1 minute')", [config.RESUME_WINDOW_MINUTES]);
    return released;
  });
  // A disconnect sweep frees sectors without any request having been made, so nothing else would
  // announce it - subscribers would sit on a stale picture until their own fallback poll.
  if (releasedAny) await publish({ type: "sectors" });
}
