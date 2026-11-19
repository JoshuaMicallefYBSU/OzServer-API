import { config } from "./config.js";
import { writeDiagnosticLog } from "./diagnostics.js";
import { transaction } from "./db.js";
import { publish } from "./events.js";
import { clearFlightsOf, reassignFreedSectors } from "./grouping.js";
import { isWithinStartupGrace } from "./presence.js";
import { SERVERS, type Server } from "./auth.js";
import type { ControllerIdentity } from "./types.js";

export async function runMaintenance(): Promise<void> {
  // The disconnect sweep is skipped until this process has been up for a full grace window, so a
  // restart is never read as every controller disconnecting at once (see presence.ts).
  const withinStartupGrace = isWithinStartupGrace(config.DISCONNECT_GRACE_MINUTES * 60_000);
  const affected = await transaction(async client => {
    // The same per-server lock every sector mutation takes (sectors.ts lockMutations), in a fixed
    // order. The sweep deletes and re-inserts ownership rows across many sectors, and without the
    // lock could deadlock with a claim working through the same rows in a different order.
    for (const server of SERVERS) {
      await client.query("SELECT pg_advisory_xact_lock(684276, hashtext($1))", [server]);
    }
    // Grouped by server: one pass can span disconnects on several servers, and a reassignment must
    // never cross servers.
    const freedByServer = new Map<string, string[]>();
    const droppedOwners: Array<ControllerIdentity & { released_sectors: string[]; released_sector_ids: string[] }> = [];
    const owners = withinStartupGrace ? [] : (await client.query(
      "SELECT DISTINCT controller_cid,controller_callsign,server FROM sector_ownerships")).rows;
    for (const owner of owners) {
      const identity = {
        cid: Number(owner.controller_cid),
        callsign: String(owner.controller_callsign),
        server: String(owner.server)
      } as ControllerIdentity;
      // Aged against last_seen_online_at (refreshed by every authenticated request - see app.ts),
      // not VATSIM's datafeed: the feed lags a new connection by tens of seconds, long enough for a
      // controller who has just claimed to look absent and lose their sectors to this sweep.
      const removed = await client.query<{ sector_id: string; name: string }>(
        `WITH deleted AS (
           DELETE FROM sector_ownerships
            WHERE controller_cid=$1 AND controller_callsign=$2 AND server=$4
              AND last_seen_online_at <= now()-($3*interval '1 minute')
          RETURNING sector_id
         )
         SELECT d.sector_id,s.name
           FROM deleted d
           JOIN sectors s ON s.id=d.sector_id`,
        [identity.cid, identity.callsign, config.DISCONNECT_GRACE_MINUTES, identity.server]);
      if (!removed.rowCount) continue;
      const freed = freedByServer.get(identity.server) ?? [];
      freed.push(...removed.rows.map(row => row.sector_id));
      freedByServer.set(identity.server, freed);
      droppedOwners.push({
        ...identity,
        released_sectors: removed.rows.map(row => row.name),
        released_sector_ids: removed.rows.map(row => row.sector_id)
      });
      await client.query(
        "DELETE FROM sector_requests WHERE (sector_id=ANY($1) OR requesting_cid=$2 OR target_cid=$2) AND server=$3",
        [removed.rows.map(row => row.sector_id), identity.cid, identity.server]);
    }
    // Every disconnected controller's rows are gone by now (reassignFreedSectors requires it), so a
    // sub-sector left behind can go to whoever is still working the group above it.
    const reassigned: string[] = [];
    for (const [server, ids] of freedByServer) {
      reassigned.push(...await reassignFreedSectors(client, ids, server));
    }
    // Their tags go to nobody, not to whoever their sectors were just reassigned to - see
    // clearFlightsOf.
    for (const owner of droppedOwners) {
      const clearedFlights = await clearFlightsOf(client, owner);
      await writeDiagnosticLog(client, owner, "ServerSector", "Disconnected controller ownership reassigned", {
        action: "disconnect_reassign",
        sectors: owner.released_sectors,
        sector_ids: owner.released_sector_ids,
        reassigned,
        fdr_authority_cleared: clearedFlights
      });
    }
    await client.query(`DELETE FROM flight_data_records WHERE last_seen_at < now()-($1*interval '1 minute')`, [config.FDR_RETAIN_MINUTES]);
    await client.query(`DELETE FROM atis_broadcasts WHERE last_seen_at < now()-($1*interval '1 minute')`, [config.ATIS_RETAIN_MINUTES]);
    // A published ATIS stays until it is replaced or ages out here (NETWORK_ATIS_RETAIN_MINUTES).
    // Aged from when it was last received, not from the letter's issue time: a plugin that keeps
    // re-publishing an unchanged ATIS is still on the air.
    const expiredAtis = (await client.query(
      `DELETE FROM network_atis WHERE received_at < now()-($1*interval '1 minute')`,
      [config.NETWORK_ATIS_RETAIN_MINUTES])).rowCount ?? 0;
    await client.query("DELETE FROM sector_requests WHERE rejected_at < now()-interval '1 day'");
    // Kept for a day: long enough to look into something reported the next morning. Purged by
    // created_at, not logged_at, which is the client's clock (see client-logs.ts) - a client whose
    // clock runs ahead would otherwise write rows this never removes.
    await client.query("DELETE FROM client_logs WHERE created_at < now()-interval '1 day'");
    await client.query("DELETE FROM resume_snapshots WHERE created_at < now()-($1*interval '1 minute')", [config.RESUME_WINDOW_MINUTES]);
    // Console messages, with their receipts and replies (ON DELETE CASCADE), once they have been
    // expired for MESSAGE_RETAIN_DAYS - long enough to read the answers afterwards.
    await client.query("DELETE FROM developer_messages WHERE expires_at < now()-($1*interval '1 day')", [config.MESSAGE_RETAIN_DAYS]);
    return {
      sectors: [...new Set(droppedOwners.map(owner => owner.server))],
      atis: expiredAtis > 0
    };
  });
  // The sweep frees sectors without a request having been made, so nothing else announces it.
  // Published once per server affected: one pass can release sectors on several servers, and a
  // subscriber watches only one.
  for (const server of affected.sectors) await publish({ type: "sectors", server });
  // An ATIS that aged out - live network only, the only place one is published (routes/atis.ts).
  if (affected.atis) await publish({ type: "atis", server: "live" });
}
