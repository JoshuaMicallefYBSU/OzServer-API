import { config } from "./config.js";
import { writeDiagnosticLog } from "./diagnostics.js";
import { transaction } from "./db.js";
import { publish } from "./events.js";
import {
  clearFlightsWithoutCurrentSectorOwner,
  reassignFreedSectors,
  transferFlightsToCurrentSectorOwners
} from "./grouping.js";
import type { ControllerIdentity } from "./types.js";
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
    const droppedOwners: Array<ControllerIdentity & { released_sectors: string[]; released_sector_ids: string[] }> = [];
    const owners = (await client.query(
      "SELECT DISTINCT controller_cid,controller_callsign FROM sector_ownerships")).rows;
    for (const owner of owners) {
      if (online.get(owner.controller_callsign.toUpperCase()) === owner.controller_cid) {
        await client.query(
          "UPDATE sector_ownerships SET last_seen_online_at=now() WHERE controller_cid=$1 AND controller_callsign=$2",
          [owner.controller_cid, owner.controller_callsign]);
        continue;
      }
      const identity = { cid: Number(owner.controller_cid), callsign: String(owner.controller_callsign) };
      // Grace-gated, not immediate: the online map comes from the VATSIM public datafeed, which can
      // lag a real connection by the better part of a minute (see PrimaryPosition.cs on the plugin
      // side for the same lag, measured against the same feed). Dropping an online-lookup miss
      // straight into this DELETE - as this briefly did - reads a controller who only just connected,
      // and whose own claim has not appeared in the feed yet, as gone, and deletes the sectors they
      // just claimed out from under them. last_seen_online_at is exactly the timestamp that already
      // exists to guard against that: it is only ever refreshed while a controller IS found online
      // (above), so a genuinely-present-but-not-yet-published controller still has a recent value to
      // fall back on. Requiring it to be older than the grace window before deleting restores the
      // tolerance every other consumer of this column already gets (annotations, below) without
      // giving up the immediate reassignment this sweep now does for a controller who really has
      // dropped.
      const removed = await client.query<{ sector_id: string; name: string }>(
        `WITH deleted AS (
           DELETE FROM sector_ownerships
            WHERE controller_cid=$1 AND controller_callsign=$2
              AND last_seen_online_at <= now()-($3*interval '1 minute')
          RETURNING sector_id
         )
         SELECT d.sector_id,s.name
           FROM deleted d
           JOIN sectors s ON s.id=d.sector_id`,
        [identity.cid, identity.callsign, config.DISCONNECT_GRACE_MINUTES]);
      if (!removed.rowCount) continue;
      released = true;
      freed.push(...removed.rows.map(row => row.sector_id));
      droppedOwners.push({
        ...identity,
        released_sectors: removed.rows.map(row => row.name),
        released_sector_ids: removed.rows.map(row => row.sector_id)
      });
      await client.query("DELETE FROM sector_requests WHERE sector_id=ANY($1) OR requesting_cid=$2 OR target_cid=$2",
        [removed.rows.map(row => row.sector_id), identity.cid]);
    }
    // Every disconnected controller's rows are gone by now, so a sub-sector left behind can be
    // handed to whoever is still working the group above it.
    const reassigned = await reassignFreedSectors(client, freed);
    for (const owner of droppedOwners) {
      const transferredFlights = await transferFlightsToCurrentSectorOwners(client, owner);
      const clearedFlights = await clearFlightsWithoutCurrentSectorOwner(client, owner);
      await writeDiagnosticLog(client, owner, "ServerSector", "Disconnected controller ownership reassigned", {
        action: "disconnect_reassign",
        sectors: owner.released_sectors,
        sector_ids: owner.released_sector_ids,
        reassigned,
        fdr_authority_transferred: transferredFlights,
        fdr_authority_cleared: clearedFlights
      });
    }
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
