import type pg from "pg";
import type { ControllerIdentity } from "./types.js";

// A sub-sector whose controller drops off goes back to whoever is working the group it sits
// inside, who is already covering that airspace, rather than being left unowned.
//
// Ancestry is walked outwards one level at a time rather than jumping to any owned ancestor, so the
// nearest staffed group wins: if both ISA and whatever bundles ISA are online, the sub-sector goes
// to ISA. Bounded like the plugin's own tree recursion, against a cyclical grouping in the dataset.
const MAX_DEPTH = 8;

type Owner = { controller_cid: number; controller_callsign: string };
type FlightAuthorityTransfer = {
  callsign: string;
  current_sector: string | null;
  from: ControllerIdentity;
  to: ControllerIdentity;
};

// As in sectors.ts `covered`, only the ownership side of the join is scoped to `server`, and in the
// join condition: a WHERE filter would drop a parent that is unowned on this server, which is the
// "keep climbing" case this function relies on.
async function findNearestGroupOwner(client: pg.PoolClient, name: string, server: string): Promise<Owner | null> {
  let frontier = [name];
  const seen = new Set(frontier);

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const parents = (await client.query<{ name: string; controller_cid: number | null; controller_callsign: string | null }>(
      `SELECT p.name, o.controller_cid, o.controller_callsign
         FROM sectors p
         LEFT JOIN sector_ownerships o ON o.sector_id = p.id AND o.server = $2
        WHERE p.responsible_sectors ?| $1::text[]
        ORDER BY jsonb_array_length(p.responsible_sectors), p.name`,
      [frontier, server])).rows;

    // Most specific group first, courtesy of the ORDER BY - a sector bundled by both a small group
    // and a large one should follow the small one.
    const owned = parents.find(parent => parent.controller_cid !== null);
    if (owned) {
      return { controller_cid: owned.controller_cid!, controller_callsign: owned.controller_callsign! };
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

    await client.query(
      `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at,server)
       VALUES ($1,$2,$3,now(),$4) ON CONFLICT (sector_id, server) DO NOTHING`,
      [sector.id, owner.controller_cid, owner.controller_callsign, server]);

    reassigned.push(sector.name);
  }

  return reassigned;
}

// TMA (approach and departure) sectors. Their aircraft never move with a change of sector owner:
// the volumes stacked inside a TMA cannot be relied on to say which controller an aircraft belongs
// to, so the controllers hand each one over themselves. The plugin keeps them with whoever has them
// (SectorTagHandoff), and every transfer of FDR authority below leaves them alone to match.
export const TMA_SECTOR_TYPES_SQL = "('APP','DEP')";

export async function transferFlightsInSectorsToOwner(
  client: pg.PoolClient,
  sectors: Array<{ sector: string; cid: number | null; callsign: string | null }>,
  owner: ControllerIdentity
): Promise<FlightAuthorityTransfer[]> {
  if (sectors.length === 0) return [];

  const transferred: FlightAuthorityTransfer[] = [];
  for (const sector of sectors) {
    // Only tags that were the previous owner's move with the sector - a sector changing hands
    // takes its controller's aircraft with it. A sector nobody held had no tags to hand over: the
    // flights in it were nobody's, and naming the claimer on them made the plugin take them on
    // its next resume. N677PL, untracked and only passing through WOL, was picked up by
    // ML-SNO_CTR that way the moment they claimed SNO.
    if (sector.cid === null) continue;

    const rows = (await client.query<{
      callsign: string;
      current_sector: string | null;
      previous_cid: number | null;
      previous_callsign: string | null;
    }>(
      `WITH previous AS (
         SELECT callsign,current_sector,controlling_cid,controlling_callsign
           FROM flight_data_records
          WHERE current_sector=$1
            AND server=$6
            AND controlling_cid=$2 AND controlling_callsign IS NOT DISTINCT FROM $3
            AND current_sector NOT IN (SELECT name FROM sectors WHERE type IN ${TMA_SECTOR_TYPES_SQL})
            AND (controlling_cid IS DISTINCT FROM $4 OR controlling_callsign IS DISTINCT FROM $5)
       ),
       updated AS (
         UPDATE flight_data_records f
            SET controlling_cid=$4,controlling_callsign=$5
           FROM previous p
          WHERE f.callsign=p.callsign AND f.server=$6
          RETURNING f.callsign,f.current_sector,
                    p.controlling_cid AS previous_cid,p.controlling_callsign AS previous_callsign
       )
       SELECT * FROM updated`,
      [sector.sector, sector.cid, sector.callsign, owner.cid, owner.callsign, owner.server])).rows;

    transferred.push(...rows.map(row => ({
      callsign: row.callsign,
      current_sector: row.current_sector,
      from: { cid: row.previous_cid ?? 0, callsign: row.previous_callsign ?? "", server: owner.server },
      to: owner
    })));
  }

  return transferred;
}

export async function transferFlightsToCurrentSectorOwners(
  client: pg.PoolClient,
  from: ControllerIdentity
): Promise<FlightAuthorityTransfer[]> {
  const rows = (await client.query<{
    callsign: string;
    current_sector: string | null;
    to_cid: number;
    to_callsign: string;
  }>(
    `UPDATE flight_data_records f
        SET controlling_cid=o.controller_cid,controlling_callsign=o.controller_callsign
       FROM sectors s
       JOIN sector_ownerships o ON o.sector_id=s.id AND o.server=$3
      WHERE f.controlling_cid=$1
        AND f.controlling_callsign=$2
        AND f.server=$3
        AND f.current_sector=s.name
        AND s.type NOT IN ${TMA_SECTOR_TYPES_SQL}
        AND (o.controller_cid IS DISTINCT FROM $1 OR o.controller_callsign IS DISTINCT FROM $2)
      RETURNING f.callsign,f.current_sector,o.controller_cid AS to_cid,o.controller_callsign AS to_callsign`,
    [from.cid, from.callsign, from.server])).rows;

  return rows.map(row => ({
    callsign: row.callsign,
    current_sector: row.current_sector,
    from,
    to: { cid: row.to_cid, callsign: row.to_callsign, server: from.server }
  }));
}

export async function clearFlightsWithoutCurrentSectorOwner(
  client: pg.PoolClient,
  from: ControllerIdentity
): Promise<string[]> {
  return (await client.query<{ callsign: string }>(
    `UPDATE flight_data_records f
        SET controlling_cid=NULL,controlling_callsign=NULL
      WHERE f.controlling_cid=$1
        AND f.controlling_callsign=$2
        AND f.server=$3
        AND NOT EXISTS (
          SELECT 1
            FROM sectors s
            JOIN sector_ownerships o ON o.sector_id=s.id AND o.server=$3
           WHERE s.name=f.current_sector
             -- Not moved to a TMA sector's owner (see TMA_SECTOR_TYPES_SQL), so cleared instead.
             AND s.type NOT IN ${TMA_SECTOR_TYPES_SQL})
      RETURNING callsign`,
    [from.cid, from.callsign, from.server])).rows.map(row => row.callsign);
}
