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

export async function runMaintenance(): Promise<void> {
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
      const identity = { cid: Number(owner.controller_cid), callsign: String(owner.controller_callsign) };
      // Aged against last_seen_online_at alone, not against VATSIM's public datafeed - this used to
      // cross-check "is this callsign/cid pair listed online right now" against that feed before
      // trusting the age of the row at all, refreshing it only on a match. That feed is a
      // third-party's own view, fetched here through a 15s cache stacked on top of VATSIM's own
      // publish interval, and it lags a real connection in BOTH directions: slow to show an arrival
      // (a controller who had just claimed sectors could look entirely absent from it, and lose
      // those sectors to this very sweep before the feed ever caught up) and no faster to show a
      // departure than this grace window already is on its own.
      //
      // last_seen_online_at is refreshed on every authenticated request a controller's own client
      // makes - see the heartbeat hook in app.ts - which every connected client already does every
      // couple of seconds regardless of what it's doing, independent of any outside feed's own
      // schedule. That is a strictly faster and more direct "are they still here" signal than
      // anything a third party can report about a connection this server isn't even part of, and it
      // is entirely this plugin's and this server's own doing - nothing external to keep in sync
      // with, and no separate "the feed itself is down" case to special-case around.
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
