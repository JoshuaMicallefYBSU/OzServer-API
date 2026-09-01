import type pg from "pg";

// A sub-sector whose controller drops off belongs back with whoever is working the group it sits
// inside - not to nobody. Previously it simply went unowned until someone claimed it by hand, even
// though the controller responsible for its parent group was online the whole time and already
// covering that airspace on their own scope.
//
// Ancestry is walked outwards one level at a time rather than jumping to any owned ancestor, so the
// nearest staffed group wins: if both ISA and whatever bundles ISA are online, the sub-sector goes
// to ISA. Bounded like the plugin's own tree recursion, against a cyclical grouping in the dataset.
const MAX_DEPTH = 8;

type Owner = { controller_cid: number; controller_callsign: string };

async function findNearestGroupOwner(client: pg.PoolClient, name: string): Promise<Owner | null> {
  let frontier = [name];
  const seen = new Set(frontier);

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const parents = (await client.query<{ name: string; controller_cid: number | null; controller_callsign: string | null }>(
      `SELECT p.name, o.controller_cid, o.controller_callsign
         FROM sectors p
         LEFT JOIN sector_ownerships o ON o.sector_id = p.id
        WHERE p.responsible_sectors ?| $1::text[]
        ORDER BY jsonb_array_length(p.responsible_sectors), p.name`,
      [frontier])).rows;

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
  freedSectorIds: Array<string | number>
): Promise<string[]> {
  if (freedSectorIds.length === 0) return [];

  const freed = (await client.query<{ id: string; name: string }>(
    "SELECT id,name FROM sectors WHERE id = ANY($1)", [freedSectorIds])).rows;

  const reassigned: string[] = [];

  for (const sector of freed) {
    // Somebody claimed it in the meantime - leave it with them rather than overriding a live claim.
    if ((await client.query("SELECT 1 FROM sector_ownerships WHERE sector_id=$1", [sector.id])).rowCount) {
      continue;
    }

    const owner = await findNearestGroupOwner(client, sector.name);
    if (!owner) continue;

    await client.query(
      `INSERT INTO sector_ownerships (sector_id,controller_cid,controller_callsign,last_seen_online_at)
       VALUES ($1,$2,$3,now()) ON CONFLICT (sector_id) DO NOTHING`,
      [sector.id, owner.controller_cid, owner.controller_callsign]);

    reassigned.push(sector.name);
  }

  return reassigned;
}
