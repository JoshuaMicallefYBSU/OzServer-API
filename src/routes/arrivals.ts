import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { writeDiagnosticLog } from "../diagnostics.js";
import { transaction } from "../db.js";
import { publish } from "../events.js";
import type { ControllerIdentity } from "../types.js";

// The plugin's Arrival List window ("A:YSSY List" - ArrivalListWindow.cs), which replaces vatSys's
// own so every OzServer controller sees the same list in the same order.
//
// The list is every activated flight record inbound to the airport that has departed, so it
// follows the FDRs: a flight joins once its record has an ATD and leaves when it completes, is
// cancelled or ages out. Its landing time, type and global ops are the record's, kept current by
// whichever plugin is pushing that FDR (FdrSync). Only the order controllers have dragged flights
// into is stored here (arrival_sequences).
//
// Who may reorder: anyone, unless the airport's flow position is online on OzServer - CB_FMP for
// YSCB - and then only that position.

// A plugin reports its open lists every ArrivalListSync.ViewingInterval (10 s), so a viewer who has
// not been heard from for three of those has closed vatSys or lost OzServer.
const VIEWER_TIMEOUT_SECONDS = 30;

// As PLUGIN_CLIENT_WINDOW_SECONDS in sectors.ts: every authenticated call refreshes plugin_clients,
// and the plugin calls every few seconds, so a client missing for longer than this has gone.
const FMP_ONLINE_WINDOW_SECONDS = 15;

// The lock key for one airport's reorders, so two controllers dragging at once are applied one
// after the other rather than interleaved. 684276 is the sector-mutation lock (sectors.ts).
const SEQUENCE_LOCK = 684277;

const adesSchema = z.string().trim().regex(/^[A-Za-z0-9]{3,4}$/).transform(value => value.toUpperCase());

const sequenceSchema = z.object({
  callsign: z.string().trim().min(1).max(20).transform(value => value.toUpperCase()),
  // -1 takes the flight out of the sequence (above the bar); 0 is the bottom.
  seq_index: z.number().int().min(-1).max(1000)
}).passthrough();

const viewingSchema = z.object({
  airports: z.array(adesSchema).max(10)
}).passthrough();

// The flow position for an airport: the ICAO's last two letters, as Australian positions are named
// (YSCB -> CB_FMP, YMML -> ML_FMP). A relief or split callsign (CB_1_FMP) counts too.
function fmpPattern(ades: string): string {
  return `^${ades.slice(-2)}(_[A-Z0-9]+)*_FMP$`;
}

function isFmpFor(callsign: string, ades: string): boolean {
  return new RegExp(fmpPattern(ades), "i").test(callsign);
}

type Member = {
  callsign: string;
  seq_index: number | null;
  eta: string | null;
  aircraft_type: string | null;
  aircraft_wake: string | null;
  global_op_data: string | null;
};

// Every flight on the airport's list, with its stored place if it has one: activated (a record
// exists only for one), not completed or inactive, and departed.
async function members(client: pg.PoolClient, server: string, ades: string): Promise<Member[]> {
  return (await client.query<Member>(
    `SELECT f.callsign,s.seq_index,f.data->>'eta' AS eta,f.data->>'aircraft_type' AS aircraft_type,
            f.data->>'aircraft_wake' AS aircraft_wake,f.data->>'global_op_data' AS global_op_data
       FROM flight_data_records f
       LEFT JOIN arrival_sequences s ON s.server=f.server AND s.ades=$2 AND s.callsign=f.callsign
      WHERE f.server=$1 AND upper(f.data->>'des_airport')=$2
        AND coalesce(f.data->>'state','') NOT IN ('STATE_FINISHED','STATE_INACTIVE')
        AND coalesce(f.data->>'atd','') <> ''`,
    [server, ades])).rows;
}

// The sequenced flights bottom first (index 0 up), then the unsequenced by landing time. Renumbered
// so the indices are contiguous whatever is stored: the window works out where a dropped flight
// lands by counting the sequenced flights it was shown, so a gap left by a flight that has since
// gone would put the next drop one place off.
function ordered(list: Member[]): { sequenced: Member[]; unsequenced: Member[] } {
  const sequenced = list.filter(member => member.seq_index != null && member.seq_index >= 0)
    .sort((left, right) => left.seq_index! - right.seq_index! || left.callsign.localeCompare(right.callsign));
  const unsequenced = list.filter(member => member.seq_index == null || member.seq_index < 0)
    .sort((left, right) => (left.eta ?? "~").localeCompare(right.eta ?? "~") || left.callsign.localeCompare(right.callsign));
  return { sequenced, unsequenced };
}

async function viewerCounts(client: pg.PoolClient, server: string, airports: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(airports.map(ades => [ades, 0]));
  if (airports.length === 0) return counts;
  const rows = (await client.query<{ ades: string; viewers: string }>(
    `SELECT ades,count(DISTINCT (controller_cid,controller_callsign)) AS viewers FROM arrival_list_viewers
      WHERE server=$1 AND ades=ANY($2) AND last_seen_at >= now()-($3*interval '1 second') GROUP BY ades`,
    [server, airports, VIEWER_TIMEOUT_SECONDS])).rows;
  for (const row of rows) counts[row.ades] = Number(row.viewers);
  return counts;
}

// The airport's flow controller on OzServer right now, if any.
async function onlineFmp(client: pg.PoolClient, server: string, ades: string): Promise<string | null> {
  const row = (await client.query<{ callsign: string }>(
    `SELECT controller_callsign AS callsign FROM plugin_clients
      WHERE server=$1 AND controller_callsign ~* $2 AND last_seen_at >= now()-($3*interval '1 second')
      ORDER BY last_seen_at DESC LIMIT 1`,
    [server, fmpPattern(ades), FMP_ONLINE_WINDOW_SECONDS])).rows[0];
  return row?.callsign ?? null;
}

function mayMove(identity: ControllerIdentity, ades: string, fmp: string | null): boolean {
  return fmp == null || isFmpFor(identity.callsign, ades);
}

// The window's whole state, as both the GET and a reorder answer it. Listed top of the window
// first: the unsequenced flights above the bar, then the sequence from its top down.
async function arrivalList(client: pg.PoolClient, identity: ControllerIdentity, ades: string) {
  const { sequenced, unsequenced } = ordered(await members(client, identity.server, ades));
  const row = (member: Member, seq_index: number) => ({
    callsign: member.callsign,
    seq_index,
    eta: member.eta,
    aircraft_type: member.aircraft_type,
    aircraft_wake: member.aircraft_wake,
    global_op_data: member.global_op_data
  });
  const flights = [
    ...unsequenced.map(member => row(member, -1)),
    ...sequenced.map((member, index) => row(member, index)).reverse()
  ];
  const viewers = (await viewerCounts(client, identity.server, [ades]))[ades] ?? 0;
  const fmp = await onlineFmp(client, identity.server, ades);
  return {
    ades,
    flights,
    viewers,
    fmp: { position: `${ades.slice(-2)}_FMP`, online: fmp != null, callsign: fmp },
    can_move: mayMove(identity, ades, fmp)
  };
}

export async function arrivalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { ades: string } }>("/arrivals/:ades", async (request, reply) => {
    const ades = adesSchema.safeParse(request.params.ades);
    if (!ades.success) return reply.code(422).send({ message: "Invalid airport." });
    return transaction(client => arrivalList(client, request.controller, ades.data));
  });

  // A flight dragged to a new place. seq_index counts among the sequenced flights with it in: 0 is
  // the bottom, and anything past the top is the top. -1 puts it back above the bar.
  app.post<{ Params: { ades: string } }>("/arrivals/:ades/sequence", async (request, reply) => {
    const ades = adesSchema.safeParse(request.params.ades);
    if (!ades.success) return reply.code(422).send({ message: "Invalid airport." });
    const parsed = sequenceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid sequence change.", errors: parsed.error.flatten() });
    const identity = request.controller;
    const { callsign, seq_index } = parsed.data;

    // Answered after COMMIT, not from inside the transaction - as in routes/sectors.ts.
    const outcome = await transaction(async (client): Promise<{ code: number; body: unknown }> => {
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [SEQUENCE_LOCK, `${identity.server}|${ades.data}`]);

      const fmp = await onlineFmp(client, identity.server, ades.data);
      if (!mayMove(identity, ades.data, fmp)) {
        await writeDiagnosticLog(client, identity, "ServerArrivals", `Refused to resequence ${callsign} at ${ades.data}; ${fmp} is online`, {
          action: "arrival_sequence_refused",
          fdr_callsign: callsign,
          ades: ades.data,
          seq_index,
          fmp
        });
        return { code: 403, body: { message: `${fmp} is online - only they can change the ${ades.data} arrival sequence.` } };
      }

      const list = await members(client, identity.server, ades.data);
      const flight = list.find(member => member.callsign.toUpperCase() === callsign);
      if (!flight) return { code: 404, body: { message: `${callsign} is not on the ${ades.data} arrival list.` } };

      const others = ordered(list).sequenced.map(member => member.callsign).filter(name => name !== flight.callsign);
      if (seq_index >= 0) others.splice(Math.min(seq_index, others.length), 0, flight.callsign);

      // The whole airport is rewritten: every index below the moved flight shifts, and rows for
      // flights no longer on the list go.
      await client.query("DELETE FROM arrival_sequences WHERE server=$1 AND ades=$2", [identity.server, ades.data]);
      if (others.length > 0) {
        await client.query(
          `INSERT INTO arrival_sequences (server,ades,callsign,seq_index,updated_by_cid,updated_by_callsign)
           SELECT $1,$2,callsign,index-1,$4,$5 FROM unnest($3::text[]) WITH ORDINALITY AS t(callsign,index)`,
          [identity.server, ades.data, others, identity.cid, identity.callsign]);
      }
      await writeDiagnosticLog(client, identity, "ServerArrivals", `Resequenced ${flight.callsign} at ${ades.data}`, {
        action: "arrival_sequence",
        fdr_callsign: flight.callsign,
        ades: ades.data,
        seq_index,
        sequence: others
      });
      return { code: 200, body: await arrivalList(client, identity, ades.data) };
    });

    if (outcome.code === 200) await publish({ type: "arrivals", server: identity.server });
    return reply.code(outcome.code).send(outcome.body);
  });

  // The Arrival Lists this controller has open, all of them, every few seconds and whenever one
  // opens or closes. Answers how many controllers have each one open.
  app.post("/arrivals/viewing", async (request, reply) => {
    const parsed = viewingSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ message: "Invalid arrival list report.", errors: parsed.error.flatten() });
    const identity = request.controller;
    const airports = [...new Set(parsed.data.airports)];

    const { counts, changed } = await transaction(async client => {
      const before = new Set((await client.query<{ ades: string }>(
        `SELECT ades FROM arrival_list_viewers
          WHERE server=$1 AND controller_cid=$2 AND controller_callsign=$3 AND last_seen_at >= now()-($4*interval '1 second')`,
        [identity.server, identity.cid, identity.callsign, VIEWER_TIMEOUT_SECONDS])).rows.map(row => row.ades));
      await client.query(
        "DELETE FROM arrival_list_viewers WHERE server=$1 AND controller_cid=$2 AND controller_callsign=$3 AND NOT (ades=ANY($4))",
        [identity.server, identity.cid, identity.callsign, airports]);
      if (airports.length > 0) {
        await client.query(
          `INSERT INTO arrival_list_viewers (server,ades,controller_cid,controller_callsign,last_seen_at)
           SELECT $1,ades,$3,$4,now() FROM unnest($2::text[]) AS t(ades)
           ON CONFLICT (server,ades,controller_callsign,controller_cid) DO UPDATE SET last_seen_at=now()`,
          [identity.server, airports, identity.cid, identity.callsign]);
      }
      const changed = before.size !== airports.length || airports.some(ades => !before.has(ades));
      return { counts: await viewerCounts(client, identity.server, airports), changed };
    });

    // Only when a list opened or closed, so the others' title bars catch up at once. The report
    // itself repeats every few seconds per controller, and announcing each one would have every
    // client re-read its lists that often for nothing.
    if (changed) await publish({ type: "arrivals", server: identity.server });
    return { viewers: counts };
  });
}
