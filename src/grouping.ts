import type pg from "pg";
import type { ControllerIdentity } from "./types.js";

// A sub-sector whose controller drops off goes back to whoever is working the group it sits
// inside, who is already covering that airspace, rather than being left unowned.
//
// Ancestry is walked outwards one level at a time rather than jumping to any owned ancestor, so the
// nearest staffed group wins: if both ISA and whatever bundles ISA are online, the sub-sector goes
// to ISA. Bounded like the plugin's own tree recursion, against a cyclical grouping in the dataset.
const MAX_DEPTH = 8;

type Owner = { controller_cid: number; controller_callsign: string; last_seen_online_at: Date | string | null };

// As in sectors.ts `covered`, only the ownership side of the join is scoped to `server`, and in the
// join condition: a WHERE filter would drop a parent that is unowned on this server, which is the
// "keep climbing" case this function relies on.
async function findNearestGroupOwner(client: pg.PoolClient, name: string, server: string): Promise<Owner | null> {
  let frontier = [name];
  const seen = new Set(frontier);

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const parents = (await client.query<{ name: string; controller_cid: number | null; controller_callsign: string | null; last_seen_online_at: Date | string | null }>(
      `SELECT p.name, o.controller_cid, o.controller_callsign, o.last_seen_online_at
         FROM sectors p
         LEFT JOIN sector_ownerships o ON o.sector_id = p.id AND o.server = $2
        WHERE p.responsible_sectors ?| $1::text[]
        ORDER BY jsonb_array_length(p.responsible_sectors), p.name`,
      [frontier, server])).rows;

    // Most specific group first, courtesy of the ORDER BY - a sector bundled by both a small group
    // and a large one should follow the small one.
    const owned = parents.find(parent => parent.controller_cid !== null);
    if (owned) {
      return { controller_cid: owned.controller_cid!, controller_callsign: owned.controller_callsign!, last_seen_online_at: owned.last_seen_online_at };
    }

    frontier = parents.map(parent => parent.name).filter(parentName => !seen.has(parentName));
    for (const parentName of frontier) seen.add(parentName);
  }

  return null;
}

// Call only after every relevant ownership row has already been deleted. Reassigning while some are
// still present would hand a sub-sector straight back to the controller who is in the middle of
// giving it up.
export async function reassignFreedSectors(
  client: pg.PoolClient,
  freedSectorIds: Array<string | number>,
  server: string
): Promise<string[]> {
  if (freedSectorIds.length === 0) return [];

  const freed = (await client.query<{ id: string; name: string }>(
    "SELECT id,name FROM sectors WHERE id = ANY($1)", [freedSectorIds])).rows;

  const reassigned: string[] = [];

  for (const sector of freed) {
    // Somebody claimed it in the meantime - leave it with them.
    if ((await client.query("SELECT 1 FROM sector_ownerships WHERE sector_id=$1 AND server=$2", [sector.id, server])).rowCount) {
      continue;
    }

    const owner = await findNearestGroupOwner(client, sector.name, server);
    if (!owner) continue;

    // As last heard from as the row it follows, not as of now. The group's owner may have dropped
    // too and be waiting out the same grace period: stamped now, this one row read as a present
    // controller's, outlived the sweep that took the rest of theirs, and kept the sector with
    // somebody long gone for another full grace period.
    await client.query(
      `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at,server)
       VALUES ($1,$2,$3,COALESCE($5::timestamptz, now()),$4) ON CONFLICT (sector_id, server) DO NOTHING`,
      [sector.id, owner.controller_cid, owner.controller_callsign, server, owner.last_seen_online_at]);

    reassigned.push(sector.name);
  }

  return reassigned;
}

// TMA (approach and departure) sectors. Their aircraft never move with a change of sector owner:
// the volumes stacked inside a TMA cannot be relied on to say which controller an aircraft belongs
// to, so the controllers hand each one over themselves. The plugin keeps them with whoever has them
// (SectorTagHandoff), and a handover's transfer of FDR authority (transferRequest) leaves them
// alone to match.
export const TMA_SECTOR_TYPES_SQL = "('APP','DEP')";

// Leaves a controller's tags with nobody: every one, or only those whose aircraft is in one of
// `sectors`. Run whenever airspace leaves a controller other than by a handover - their release-all,
// the disconnect sweep, a claim on a sector of theirs after they dropped. The aircraft stay on
// OzServer, and every client still activates them (FdrResumeActivation), but nobody is given the
// tag: whoever now holds the airspace picks each one up by hand. The only automatic moves of a tag
// are a handover (transferRequest), a controller's own reconnect (POST /sectors/resume) and a
// position taken over under the same callsign (handOverPosition in routes/sectors.ts).
export async function clearFlightsOf(
  client: pg.PoolClient,
  from: ControllerIdentity,
  sectors?: string[]
): Promise<string[]> {
  if (sectors && sectors.length === 0) return [];
  return (await client.query<{ callsign: string }>(
    `UPDATE flight_data_records
        SET controlling_cid=NULL,controlling_callsign=NULL
      WHERE controlling_cid=$1
        AND controlling_callsign IS NOT DISTINCT FROM $2
        AND server=$3
        AND ($4::text[] IS NULL OR current_sector = ANY($4::text[]))
      RETURNING callsign`,
    [from.cid, from.callsign, from.server, sectors ?? null])).rows.map(row => row.callsign);
}
