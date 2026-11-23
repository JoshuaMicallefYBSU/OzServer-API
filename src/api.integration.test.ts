import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// End-to-end tests of the routes against a real Postgres: the claim, transfer, resume and sweep
// rules are almost entirely SQL plus the order things happen in.
//
// Needs TEST_DATABASE_URL pointing at a database this may wipe (it drops and recreates the public
// schema). Skipped when that is not set, so `npm test` still runs everywhere; CI sets it.
//
//   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test
const databaseUrl = process.env.TEST_DATABASE_URL;

type Identity = { cid: number; callsign: string; server?: string };

describe.skipIf(!databaseUrl)("API against Postgres", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let runMaintenance: () => Promise<void>;

  const body = (who: Identity, extra: Record<string, unknown> = {}) =>
    ({ ...extra, controller_cid: who.cid, controller_callsign: who.callsign, server: who.server ?? "live" });
  const post = (url: string, who: Identity, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/api/v1${url}`, payload: body(who, extra) });
  const get = (url: string, who: Identity) =>
    app.inject({
      method: "GET",
      url: `/api/v1${url}?controller_cid=${who.cid}&controller_callsign=${who.callsign}&server=${who.server ?? "live"}`
    });
  const mine = async (who: Identity) =>
    ((await get("/sectors/sync", who)).json().mine as Array<{ name: string }>).map(sector => sector.name).sort();
  // Makes a controller look as though their client stopped calling a while ago.
  const goQuiet = (who: Identity, seconds = 60) => db.query(
    "UPDATE sector_ownerships SET last_seen_online_at=now()-($2*interval '1 second') WHERE controller_cid=$1",
    [who.cid, seconds]);

  // GRP is a position's primary sector. Its own position is GRP + INA; it also covers OUT top-down
  // (a neighbouring TCU's sector, say) without that being part of the position.
  const primary: Identity = { cid: 1000001, callsign: "XX-GRP_CTR" };
  const extender: Identity = { cid: 1000002, callsign: "XX-FAR_CTR" };
  const third: Identity = { cid: 1000003, callsign: "XX-OTH_CTR" };
  const consoleToken = "test-console-token-0123456789";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    // Short, so the startup grace that suspends presence checks and the sweep (see presence.ts) is
    // over after the wait below, but long enough that "just claimed" still reads as present on a
    // slow CI runner.
    process.env.PRESENCE_TIMEOUT_SECONDS = "2";
    process.env.DISCONNECT_GRACE_MINUTES = "0.05";
    process.env.CONSOLE_TOKEN = consoleToken;

    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const directory = resolve(process.cwd(), "migrations");
    for (const name of (await readdir(directory)).filter(file => file.endsWith(".sql")).sort()) {
      await db.query(await readFile(resolve(directory, name), "utf8"));
    }
    // name and full_name are separate parameters on purpose: the columns are varchar and text, and
    // Postgres refuses to infer one parameter as both.
    const sector = (name: string, callsign: string | null, responsible: string[]) => db.query(
      "INSERT INTO sectors (name,full_name,callsign,type,responsible_sectors) VALUES ($1,$2,$3,'CTR',$4)",
      [name, name, callsign, JSON.stringify(responsible)]);
    await sector("GRP", "XX-GRP_CTR", ["INA", "OUT"]);
    await sector("INA", "XX-INA_CTR", []);
    await sector("OUT", "XX-OUT_APP", []);
    await sector("FAR", "XX-FAR_CTR", []);
    // FAR on 128.400, and a tower elsewhere sharing it: an en-route controller on 128.400 works FAR
    // only (external-control.ts frequencySectors). Set before the app starts, which caches sectors.
    await db.query("UPDATE sectors SET frequency='128.400' WHERE name='FAR'");
    await db.query(`INSERT INTO sectors (name,full_name,callsign,type,frequency,responsible_sectors)
                    VALUES ('ZZ ADC','Zed Tower','ZZ_TWR','TWR','128.400','[]')`);
    await db.query(
      "INSERT INTO sectors (name,full_name,callsign,type,responsible_sectors) VALUES ('XX FMP','XX FMP','XX_FMP','FMP','[]')");
    // The map places an ATIS at its airport's position, so an airport the dataset has no position
    // for cannot be drawn at all - see /map/atis.
    await db.query(
      `INSERT INTO positions (name,asmgcs_airport,default_lat,default_lon)
       VALUES ('YSSY_SMC','YSSY',-33.94,151.18),('YBBN_SMC','YBBN',-27.38,153.12)`);

    app = await (await import("./app.js")).buildApp();
    runMaintenance = (await import("./maintenance.js")).runMaintenance;
    await new Promise(done => setTimeout(done, 3_300));
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await (await import("./db.js")).pool.end();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE sector_ownerships, sector_requests, flight_data_records, client_logs, resume_snapshots, network_atis, atis_broadcasts, arrival_sequences, arrival_list_viewers");
  });

  it("rejects a request with no controller identity", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/sectors/GRP/claim", payload: {} })).statusCode).toBe(401);
  });

  it("claims a sector together with everything it covers", async () => {
    expect((await post("/sectors/GRP/claim", primary)).statusCode).toBe(201);
    expect(await mine(primary)).toEqual(["GRP", "INA", "OUT"]);
  });

  it("refuses to take a sector from a controller who is still present", async () => {
    await post("/sectors/INA/claim", extender);
    const response = await post("/sectors/INA/claim", third);
    expect(response.statusCode).toBe(409);
    expect(response.json().conflicts[0]).toMatchObject({ sector: "INA", owner: { cid: extender.cid } });
  });

  it("serves the ops picture: each controller with every sector they hold, and the requests between them", async () => {
    await post("/sectors/GRP/claim", primary);
    await post("/sectors/FAR/claim", extender);
    expect((await post("/sectors/GRP/request", extender)).statusCode).toBe(201);

    const response = await app.inject({ method: "GET", url: "/api/v1/map/ops?server=live" });
    expect(response.statusCode).toBe(200);
    const ops = response.json();
    expect(ops.ownerships.map((row: { sector: string }) => row.sector).sort()).toEqual(["FAR", "GRP", "INA", "OUT"]);
    const holder = ops.controllers.find((controller: { cid: number }) => controller.cid === primary.cid);
    expect(holder).toMatchObject({ callsign: primary.callsign, home_sector: "GRP", online: true, is_flow: false });
    expect([...holder.sectors].sort()).toEqual(["GRP", "INA", "OUT"]);
    expect(ops.requests.some((row: { sector: string; requesting_cid: number; target_cid: number }) =>
      row.sector === "GRP" && row.requesting_cid === extender.cid && row.target_cid === primary.cid)).toBe(true);

    expect((await app.inject({ method: "GET", url: "/api/v1/map/ops" })).statusCode).toBe(400);
  });

  describe("a sector whose owner dropped", () => {
    beforeEach(async () => {
      await post("/sectors/INA/claim", extender);
      await goQuiet(extender);
    });

    it("is kept for them, and the claimer is told whose it is and until when", async () => {
      const refused = await post("/sectors/INA/claim", third);
      expect(refused.statusCode).toBe(409);
      const [conflict] = refused.json().conflicts;
      expect(conflict).toMatchObject({ sector: "INA", owner: { cid: extender.cid, callsign: extender.callsign, dropped: true } });
      // DISCONNECT_GRACE_MINUTES after they were last heard from (0.05 here, set above).
      expect(Date.parse(conflict.owner.released_at) - Date.parse(conflict.owner.last_seen_at)).toBe(0.05 * 60_000);
      expect(await mine(extender)).toEqual(["INA"]);
    });

    it("is taken by a claim that says so", async () => {
      expect((await post("/sectors/INA/claim", third, { take_dropped: true })).statusCode).toBe(201);
      expect(await mine(third)).toEqual(["INA"]);
      expect(await mine(extender)).toEqual([]);
    });

    it("is shown as theirs, dropped, to everyone else", async () => {
      const controlled = (await get("/sectors/sync", third)).json().controlled;
      expect(controlled).toContainEqual(expect.objectContaining({ name: "INA", owner: expect.objectContaining({ callsign: extender.callsign, dropped: true }) }));
    });

    it("cannot be requested from them, since nobody can answer", async () => {
      const response = await post("/sectors/INA/request", third);
      expect(response.statusCode).toBe(409);
      expect(response.json().dropped).toMatchObject({ callsign: extender.callsign });
    });

    it("goes to a controller under their callsign without being asked", async () => {
      expect((await post("/sectors/INA/claim", { cid: 1000009, callsign: extender.callsign })).statusCode).toBe(201);
    });

    it("is taken through a commit that says so, and listed as a conflict in one that does not", async () => {
      const left = (await post("/sectors/commit", third, { claim: ["INA"] })).json().result;
      expect(left.skipped).toEqual(["INA"]);
      expect(left.conflicts).toMatchObject([{ sector: "INA", owner: { dropped: true } }]);
      expect((await post("/sectors/commit", third, { claim: ["INA"], take_dropped: true })).json().result.claimed).toEqual(["INA"]);
    });
  });

  describe("a primary logging on over a controller who extended into its airspace", () => {
    beforeEach(async () => {
      await post("/sectors/INA/claim", extender);
      await post("/sectors/OUT/claim", extender);
    });

    it("does not take its own position off a present controller - it has to ask", async () => {
      const first = await post("/sectors/GRP/claim", primary, { primary_group: ["GRP", "INA"] });
      expect(first.statusCode).toBe(409);
      expect(first.json().conflicts.map((conflict: { sector: string }) => conflict.sector).sort()).toEqual(["INA", "OUT"]);
      expect(await mine(extender)).toEqual(["INA", "OUT"]);

      // What is free is still claimable around the contested pieces.
      expect((await post("/sectors/GRP/claim", primary, { exclude: ["INA", "OUT"] })).statusCode).toBe(201);
      expect(await mine(primary)).toEqual(["GRP"]);
      expect(await mine(extender)).toEqual(["INA", "OUT"]);
    });

    it("answers a claim with every covered sector carved out as nothing to do, not as a missing sector", async () => {
      // The retry a client makes after a 409 that contested everything the claim covers.
      await post("/sectors/GRP/claim", extender, { exclude: ["INA", "OUT"] });
      const contested = await post("/sectors/GRP/claim", primary);
      expect(contested.statusCode).toBe(409);
      expect(contested.json().conflicts).toHaveLength(3);

      const retried = await post("/sectors/GRP/claim", primary, { exclude: ["GRP", "INA", "OUT"] });
      expect(retried.statusCode).toBe(201);
      expect(retried.json()).toEqual([]);
      expect(await mine(extender)).toEqual(["GRP", "INA", "OUT"]);
      // A sector that really does not exist is still told apart.
      expect((await post("/sectors/NOPE/claim", primary)).statusCode).toBe(404);
    });

    it("refuses a sector to the controller logged on as it while someone present holds it", async () => {
      const response = await post("/sectors/INA/claim", { cid: 1000004, callsign: "XX-INA_CTR" });
      expect(response.statusCode).toBe(409);
      expect(await mine(extender)).toEqual(["INA", "OUT"]);
    });

    it("gets its own position once the holder accepts the request", async () => {
      await post("/sectors/GRP/claim", primary, { exclude: ["INA", "OUT"] });
      const requested = await post("/sectors/INA/request", primary);
      expect(requested.statusCode).toBe(201);
      expect((await post(`/sector-requests/${requested.json().id}/accept`, extender)).statusCode).toBe(200);
      expect(await mine(primary)).toEqual(["GRP", "INA"]);
      expect(await mine(extender)).toEqual(["OUT"]);
    });

    it("claims covered airspace nobody present is working once told it is a dropped controller's", async () => {
      await goQuiet(extender);
      const held = await post("/sectors/GRP/claim", primary, { primary_group: ["GRP", "INA"] });
      expect(held.statusCode).toBe(409);
      expect(held.json().conflicts.every((conflict: { owner: { dropped?: boolean } }) => conflict.owner.dropped)).toBe(true);
      expect((await post("/sectors/GRP/claim", primary, { take_dropped: true })).statusCode).toBe(201);
      expect(await mine(primary)).toEqual(["GRP", "INA", "OUT"]);
    });

    it("clears requests left pointing at a controller whose sector was taken after they went quiet", async () => {
      expect((await post("/sectors/INA/request", third)).statusCode).toBe(201);
      await goQuiet(extender);
      await post("/sectors/GRP/claim", primary, { take_dropped: true });
      expect((await get("/sector-requests", third)).json().by_me).toEqual([]);
      // Which is what lets them ask the new owner instead.
      expect((await post("/sectors/INA/request", third)).statusCode).toBe(201);
    });
  });

  describe("a claim over a controller logged on inside the group", () => {
    const member: Identity = { cid: 1000004, callsign: "XX-INA_CTR" };

    it("is told when the sector it names is theirs, rather than being answered as if it worked", async () => {
      await post("/sectors/INA/claim", member);
      const response = await post("/sectors/INA/claim", third);
      expect(response.statusCode).toBe(409);
      expect(response.json().conflicts).toEqual([{ sector: "INA", owner: { cid: member.cid, callsign: member.callsign } }]);
    });

    it("quietly leaves them what it merely covers", async () => {
      await post("/sectors/INA/claim", member);
      const response = await post("/sectors/GRP/claim", primary);
      expect(response.statusCode).toBe(201);
      expect(await mine(primary)).toEqual(["GRP", "OUT"]);
      expect(await mine(member)).toEqual(["INA"]);
    });

    it("still leaves them the rest of what they hold there once their own sector is carved out", async () => {
      // The client excludes the sectors it knows the logged-on position is made of. What that
      // controller holds inside the group beyond those is still theirs, and not a conflict.
      await post("/sectors/INA/claim", member);
      await post("/sectors/OUT/claim", member);
      const response = await post("/sectors/GRP/claim", primary, { exclude: ["INA"] });
      expect(response.statusCode).toBe(201);
      expect(await mine(primary)).toEqual(["GRP"]);
      expect(await mine(member)).toEqual(["INA", "OUT"]);
    });
  });

  it("transfers a sector when its owner accepts a request, and only then", async () => {
    await post("/sectors/INA/claim", extender);
    const requested = await post("/sectors/INA/request", third);
    expect(requested.statusCode).toBe(201);
    const id = requested.json().id;

    expect((await post(`/sector-requests/${id}/accept`, third)).statusCode).toBe(403);
    expect((await post(`/sector-requests/${id}/accept`, extender)).statusCode).toBe(200);
    expect(await mine(third)).toEqual(["INA"]);
    expect(await mine(extender)).toEqual([]);
  });

  describe("a flow (FMP) position", () => {
    const flow: Identity = { cid: 1000004, callsign: "XX_FMP" };

    it("holds its own FMP sector", async () => {
      expect((await post("/sectors/XX%20FMP/claim", flow)).statusCode).toBe(201);
      expect(await mine(flow)).toEqual(["XX FMP"]);
    });

    it("cannot claim enroute or TMA airspace, even when nobody holds it", async () => {
      const response = await post("/sectors/GRP/claim", flow);
      expect(response.statusCode).toBe(403);
      expect(await mine(flow)).toEqual([]);

      const committed = await post("/sectors/commit", flow, { claim: ["INA", "XX FMP"] });
      expect(committed.json().result.failed).toEqual(["INA"]);
      expect(await mine(flow)).toEqual(["XX FMP"]);
    });

    it("cannot request airspace nobody holds", async () => {
      expect((await post("/sectors/INA/request", flow)).statusCode).toBe(403);
      expect((await post("/sectors/commit", flow, { request: ["INA"] })).json().result.failed).toEqual(["INA"]);
      expect(await mine(flow)).toEqual([]);
    });

    it("can take a held sector as relief cover once its controller accepts", async () => {
      await post("/sectors/INA/claim", extender);
      // Claiming it is still refused - it has to be asked for.
      expect((await post("/sectors/INA/claim", flow)).statusCode).toBe(403);
      const requested = await post("/sectors/INA/request", flow);
      expect(requested.statusCode).toBe(201);
      expect(await mine(extender)).toEqual(["INA"]);

      expect((await post(`/sector-requests/${requested.json().id}/accept`, extender)).statusCode).toBe(200);
      expect(await mine(flow)).toEqual(["INA"]);
      expect(await mine(extender)).toEqual([]);
    });
  });

  it("answers malformed ids and bodies as client errors, not server faults", async () => {
    expect((await post("/sector-requests/not-a-number/accept", extender)).statusCode).toBe(403);
    expect((await post("/sector-requests/not-a-number/reject", extender)).statusCode).toBe(403);
    expect((await post("/sector-requests/accept-batch", extender, { request_ids: "1,2" })).statusCode).toBe(422);
    expect((await post("/sectors/INA/claim", extender, { exclude: "INA" })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/v1/client-logs?since=banana" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/client-logs?limit=-5" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/client-logs?since=2%20hours&limit=10" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/events" })).statusCode).toBe(400);
  });

  it("gives everything back on release-all and restores it on resume", async () => {
    await post("/sectors/GRP/claim", primary);
    expect((await post("/sectors/release-all", primary)).statusCode).toBe(204);
    expect(await mine(primary)).toEqual([]);

    const resumed = await post("/sectors/resume", primary);
    expect(resumed.json().resumed.sort()).toEqual(["GRP", "INA", "OUT"]);
    expect(await mine(primary)).toEqual(["GRP", "INA", "OUT"]);
  });

  it("closes a stale session under another callsign when the controller comes back as a new one", async () => {
    await post("/sectors/INA/claim", extender);
    await goQuiet(extender);
    const returning = { cid: extender.cid, callsign: "XX-NEW_CTR" };
    await post("/sectors/resume", returning);
    expect(await mine(returning)).toEqual([]);
  });

  it("leaves a second live session under the same cid alone", async () => {
    await post("/sectors/INA/claim", extender);
    await post("/sectors/resume", { cid: extender.cid, callsign: "XX-NEW_CTR" });
    expect(await mine(extender)).toEqual(["INA"]);
  });

  describe("flight data", () => {
    const flight = (extra: Record<string, unknown>) => ({ flights: [{ callsign: "QFA1", ...extra }] });
    const record = async () => (await get("/fdr/QFA1", extender)).json();

    it("keeps a value a later partial push does not mention", async () => {
      await post("/fdr/batch", extender, flight({ cfl_lower: 110, cfl_upper: 130, route: "DCT" }));
      await post("/fdr/batch", extender, flight({ lat: -33.9, lon: 151.2 }));
      expect(await record()).toMatchObject({ cfl_lower: 110, cfl_upper: 130, route: "DCT", lat: -33.9 });
    });

    it("clears a value a later push sends as an explicit null", async () => {
      await post("/fdr/batch", extender, flight({ cfl_lower: 110, cfl_upper: 130 }));
      await post("/fdr/batch", extender, flight({ cfl_lower: null, cfl_upper: 130 }));
      expect(await record()).toMatchObject({ cfl_lower: null, cfl_upper: 130 });
    });

    it("refuses a push for a flight another controller with sectors holds", async () => {
      await post("/sectors/INA/claim", extender);
      await post("/fdr/batch", extender, flight({ controlling_cid: extender.cid, controlling_callsign: extender.callsign, current_sector: "INA" }));
      const refused = await post("/fdr/batch", third, flight({ controlling_cid: third.cid, controlling_callsign: third.callsign, current_sector: "INA" }));
      expect(refused.json().results).toEqual([{ callsign: "QFA1", updated: false }]);
      expect((await record()).controlling_cid).toBe(extender.cid);
    });

    it("lets the controller a flight was handed to take it before it leaves the giver's sector", async () => {
      const held = (who: Identity, state: string) => post("/fdr/batch", who, flight({
        controlling_cid: who.cid, controlling_callsign: who.callsign, current_sector: "INA", state
      }));
      await post("/sectors/INA/claim", extender);
      await post("/sectors/FAR/claim", third);
      await held(extender, "STATE_CONTROLLED");

      // Not offered yet, so somebody else reporting it as theirs is still refused.
      expect((await held(third, "STATE_CONTROLLED")).json().results).toEqual([{ callsign: "QFA1", updated: false }]);

      await held(extender, "STATE_HANDOVER");
      // A second controller's own handover state is the stale give-away push, not an acceptance.
      expect((await held(third, "STATE_HANDOVER")).json().results).toEqual([{ callsign: "QFA1", updated: false }]);
      expect((await held(third, "STATE_CONTROLLED")).json().results).toEqual([{ callsign: "QFA1", updated: true }]);
      expect(await record()).toMatchObject({ controlling_cid: third.cid, state: "STATE_CONTROLLED", current_sector: "INA" });

      // And the giver's late push does not take it back.
      expect((await held(extender, "STATE_HANDOVER")).json().results).toEqual([{ callsign: "QFA1", updated: false }]);
      expect((await record()).controlling_cid).toBe(third.cid);
    });

    it("takes an untracked report from the controller holding the FDR's data authority sector, and no one else", async () => {
      await post("/sectors/INA/claim", extender);
      await post("/sectors/FAR/claim", third);
      await post("/fdr/batch", extender, flight({ controlling_cid: extender.cid, controlling_callsign: extender.callsign, state: "STATE_CONTROLLED" }));

      const untracked = (who: Identity, authority: string) => post("/fdr/batch", who, flight({
        controlling_cid: null, controlling_callsign: null, authority_sector: authority, state: "STATE_COORDINATED"
      }));
      // Not the data authority: refused.
      expect((await untracked(third, "INA")).json().results).toEqual([{ callsign: "QFA1", updated: false }]);
      // The holder of the authority sector: the tag was dropped, and the record now says so.
      expect((await untracked(third, "FAR")).json().results).toEqual([{ callsign: "QFA1", updated: true }]);
      expect(await record()).toMatchObject({ controlling_cid: null, authority_sector: "FAR", state: "STATE_COORDINATED" });

      // An aircraft with no live position is still served to the map.
      const aircraft = (await app.inject({ method: "GET", url: "/api/v1/map/aircraft?server=live" })).json();
      expect(aircraft.map((row: { callsign: string }) => row.callsign)).toContain("QFA1");
    });

    it("keeps an aircraft's position current from a stand-in while its controller has dropped off, and keeps their name on it", async () => {
      await post("/sectors/INA/claim", extender);
      await post("/sectors/FAR/claim", third);
      await post("/fdr/batch", extender, flight({ controlling_cid: extender.cid, controlling_callsign: extender.callsign, state: "STATE_CONTROLLED", lat: -33.9, lon: 151.2 }));

      // Gone quiet, but still within the grace period: their sectors are still theirs.
      await goQuiet(extender, 60);
      const standIn = await post("/fdr/batch", third, flight({
        controlling_cid: null, controlling_callsign: null, authority_sector: "FAR", state: "STATE_UNCONTROLLED", lat: -34.5, lon: 150.9
      }));
      expect(standIn.json().results).toEqual([{ callsign: "QFA1", updated: true }]);
      expect(await record()).toMatchObject({ controlling_cid: extender.cid, state: "STATE_CONTROLLED", lat: -34.5, lon: 150.9 });

      // Once the sweep has released their sectors, an untracked report is just that.
      await db.query("DELETE FROM sector_ownerships WHERE controller_cid=$1", [extender.cid]);
      await post("/fdr/batch", third, flight({ controlling_cid: null, controlling_callsign: null, authority_sector: "FAR", state: "STATE_UNCONTROLLED", lat: -35, lon: 150.5 }));
      expect(await record()).toMatchObject({ controlling_cid: null, state: "STATE_UNCONTROLLED", lat: -35 });
    });

    it("keeps the last route when a push leaves it out, and serves it apart from the aircraft feed", async () => {
      const route = [{ n: "YSSY", lat: -33.9461, lon: 151.1772 }, { n: "RIVET", lat: -34.1, lon: 150.6 }, { n: "YMML", lat: -37.6733, lon: 144.8433 }];
      await post("/fdr/batch", extender, flight({ route_points: route, route_next_index: 1 }));
      await post("/fdr/batch", extender, flight({ route_next_index: 2, lat: -35, lon: 149 }));

      const routes = (await app.inject({ method: "GET", url: "/api/v1/map/routes?server=live" })).json();
      expect(routes).toEqual([{ callsign: "QFA1", route_points: route, route_next_index: 2 }]);

      const [row] = (await app.inject({ method: "GET", url: "/api/v1/map/aircraft?server=live" })).json();
      expect(row).toMatchObject({ callsign: "QFA1", has_route: true });
      expect(row.route_points).toBeUndefined();
    });
  });

  describe("arrival lists", () => {
    const departed = "2026-11-23T04:00:00Z";
    const inbound = (who: Identity, callsign: string, extra: Record<string, unknown> = {}) => post("/fdr/batch", who, {
      flights: [{ callsign, des_airport: "YSSY", state: "STATE_UNCONTROLLED", atd: departed, controlling_cid: null, controlling_callsign: null, ...extra }]
    });
    const list = async (who: Identity = extender) => (await get("/arrivals/YSSY", who)).json();
    const callsigns = async (who: Identity = extender) =>
      ((await list(who)).flights as Array<{ callsign: string; seq_index: number }>).map(f => `${f.callsign}:${f.seq_index}`);
    const move = (who: Identity, callsign: string, seq_index: number) =>
      post("/arrivals/YSSY/sequence", who, { callsign, seq_index });

    it("lists every departed flight inbound, with its landing time, type and global ops", async () => {
      await inbound(extender, "QFA1", { eta: "2026-11-23T05:20:00Z", aircraft_type: "A320", aircraft_wake: "M", global_op_data: "STAR RIVET" });
      await inbound(extender, "NOTYET", { atd: undefined });
      await inbound(extender, "DONE1", { state: "STATE_FINISHED" });
      await post("/fdr/batch", extender, { flights: [{ callsign: "OUT1", des_airport: "YMML", state: "STATE_UNCONTROLLED", atd: departed }] });

      expect((await list()).flights).toEqual([{
        callsign: "QFA1", seq_index: -1, eta: "2026-11-23T05:20:00Z", aircraft_type: "A320", aircraft_wake: "M", global_op_data: "STAR RIVET"
      }]);
    });

    it("keeps the order controllers drag flights into", async () => {
      await inbound(extender, "AAA1", { eta: "2026-11-23T05:30:00Z" });
      await inbound(extender, "BBB2", { eta: "2026-11-23T05:10:00Z" });
      await inbound(extender, "CCC3", { eta: "2026-11-23T05:20:00Z" });
      // Unsequenced, by landing time.
      expect(await callsigns()).toEqual(["BBB2:-1", "CCC3:-1", "AAA1:-1"]);

      expect((await move(extender, "AAA1", 0)).statusCode).toBe(200);
      expect((await move(extender, "BBB2", 5)).statusCode).toBe(200);
      // Dropped at the bottom: everything else shifts up one.
      await move(third, "CCC3", 0);
      expect(await callsigns()).toEqual(["BBB2:2", "AAA1:1", "CCC3:0"]);

      // Back above the bar, and the rest closes up.
      await move(extender, "AAA1", -1);
      expect(await callsigns(third)).toEqual(["AAA1:-1", "BBB2:1", "CCC3:0"]);

      // A flight that completes leaves the list, and the indices stay contiguous.
      await inbound(extender, "CCC3", { state: "STATE_FINISHED" });
      expect(await callsigns()).toEqual(["AAA1:-1", "BBB2:0"]);
      expect((await move(extender, "CCC3", 0)).statusCode).toBe(404);
    });

    it("lets anyone reorder until the airport's FMP is online, then only the FMP", async () => {
      const flow: Identity = { cid: 1000005, callsign: "SY_FMP" };
      await inbound(extender, "QFA1");
      expect((await list()).fmp).toEqual({ position: "SY_FMP", online: false, callsign: null });
      expect((await list()).can_move).toBe(true);
      expect((await move(third, "QFA1", 0)).statusCode).toBe(200);

      // Any call puts the FMP on plugin_clients.
      await get("/arrivals/YSSY", flow);
      expect((await list()).fmp).toEqual({ position: "SY_FMP", online: true, callsign: "SY_FMP" });
      expect((await list()).can_move).toBe(false);
      const refused = await move(third, "QFA1", -1);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().message).toContain("SY_FMP");
      expect((await list(flow)).can_move).toBe(true);
      expect((await move(flow, "QFA1", -1)).statusCode).toBe(200);

      // Another airport's FMP changes nothing here.
      await db.query("UPDATE plugin_clients SET last_seen_at=now()-interval '1 minute' WHERE controller_cid=$1", [flow.cid]);
      await get("/arrivals/YSSY", { cid: 1000006, callsign: "ML_FMP" });
      expect((await list()).can_move).toBe(true);

      // plugin_clients is not truncated between tests: no flow position left behind for the others.
      await db.query("DELETE FROM plugin_clients WHERE controller_callsign LIKE '%\\_FMP'");
    });

    it("counts the controllers with each list open", async () => {
      const viewing = async (who: Identity, airports: string[]) =>
        (await post("/arrivals/viewing", who, { airports })).json().viewers;
      expect(await viewing(extender, ["YSSY", "ymml"])).toEqual({ YSSY: 1, YMML: 1 });
      expect(await viewing(third, ["YSSY"])).toEqual({ YSSY: 2 });
      expect((await list()).viewers).toBe(2);
      expect((await list()).viewer_callsigns).toEqual([extender.callsign, third.callsign].sort());

      // Closed: no longer counted.
      expect(await viewing(extender, ["YMML"])).toEqual({ YMML: 1 });
      expect((await list()).viewers).toBe(1);

      // Gone quiet: not counted either.
      await db.query("UPDATE arrival_list_viewers SET last_seen_at=now()-interval '1 minute' WHERE controller_cid=$1", [third.cid]);
      expect((await list()).viewers).toBe(0);
    });
  });

  it("sweeps a controller who stopped calling and hands their sector to the group above it", async () => {
    await post("/sectors/GRP/claim", primary, { exclude: ["INA"] });
    await post("/sectors/INA/claim", extender);
    await goQuiet(extender);
    await runMaintenance();
    expect(await mine(primary)).toEqual(["GRP", "INA", "OUT"]);
  });

  describe("tags when airspace changes hands without a handover", () => {
    // Two controllers on the same position one after the other. GRP's own position is GRP + INA
    // (what the plugin sends as position_sectors); OUT and FAR are extensions.
    const before: Identity = { cid: 1000005, callsign: "XX-GRP_CTR" };
    const after: Identity = { cid: 1000006, callsign: "XX-GRP_CTR" };
    const push = (who: Identity, callsign: string, sector: string) => post("/fdr/batch", who, {
      flights: [{ callsign, controlling_cid: who.cid, controlling_callsign: who.callsign, current_sector: sector, state: "STATE_CONTROLLED" }]
    });
    const holder = async (callsign: string) => (await get(`/fdr/${callsign}`, third)).json().controlling_cid;
    const logOn = (who: Identity) => post("/sectors/resume", who, { position_sectors: ["GRP", "INA"] });

    beforeEach(async () => {
      await post("/sectors/GRP/claim", before);
      await post("/sectors/FAR/claim", before);
      await push(before, "QFA1", "INA");
      await push(before, "QFA2", "FAR");
    });

    it("hands the position and its tags to the next controller of the callsign inside the window, and nothing they extended into", async () => {
      await goQuiet(before, 30);
      const resumed = (await logOn(after)).json();
      expect(resumed.resumed.sort()).toEqual(["GRP", "INA"]);
      expect(resumed.flights).toEqual(["QFA1"]);
      expect(await mine(after)).toEqual(["GRP", "INA"]);
      expect(await mine(before)).toEqual(["FAR", "OUT"]);
      expect(await holder("QFA2")).toBe(before.cid);
    });

    it("does the same after a deliberate disconnect", async () => {
      await post("/sectors/release-all", before);
      expect(await holder("QFA1")).toBeNull();
      const resumed = (await logOn(after)).json();
      expect(resumed.resumed.sort()).toEqual(["GRP", "INA"]);
      expect(resumed.flights).toEqual(["QFA1"]);
      expect(await holder("QFA2")).toBeNull();
    });

    it("hands nothing over after the window: the position is claimed and its tags go to nobody", async () => {
      await goQuiet(before, 180);
      expect((await logOn(after)).json().resumed).toEqual([]);
      expect((await post("/sectors/GRP/claim", after)).statusCode).toBe(201);
      expect(await holder("QFA1")).toBeNull();
      expect(await holder("QFA2")).toBe(before.cid);
    });

    it("leaves tags with nobody when another callsign claims a dropped controller's sector", async () => {
      await goQuiet(before, 30);
      expect((await post("/sectors/FAR/claim", third, { take_dropped: true })).statusCode).toBe(201);
      expect(await holder("QFA2")).toBeNull();
      expect(await holder("QFA1")).toBe(before.cid);
    });

    it("leaves tags with nobody when the sweep gives the sectors to the group above", async () => {
      await db.query("TRUNCATE sector_ownerships, flight_data_records");
      await post("/sectors/GRP/claim", primary, { exclude: ["INA"] });
      await post("/sectors/INA/claim", extender);
      await push(extender, "QFA1", "INA");
      await goQuiet(extender);
      await runMaintenance();
      expect(await mine(primary)).toEqual(["GRP", "INA", "OUT"]);
      expect(await holder("QFA1")).toBeNull();
    });
  });

  // PUT /vatsim/atis/:icao is a public route: the vatSys ATIS plugin sends no pluginAuth identity,
  // so these requests are built by hand rather than with post() and get().
  describe("the ATIS a vatSys ATIS plugin publishes", () => {
    const sydney = {
      icao: "YSSY", callsign: "YSSY_ATIS", atis_letter: "N", type: "atis", frequency: "126.250",
      issued: "2026-11-12T09:14:00Z",
      content: { "RWY": "34L FOR ARRS, RWY 34R FOR DEPS", "WIND": "320/15-25", "QNH": "1013" },
      changed: ["QNH", "WIND"],
      controller: { callsign: "SY_TWR", cid: "1234567" },
      client: { name: "vatSys ATIS Plugin", version: "4.3" }
    };
    const put = (icao: string, atis: Record<string, unknown> = sydney) =>
      app.inject({ method: "PUT", url: `/api/v1/vatsim/atis/${icao}`, payload: atis });
    // No trailing slash when every airport is wanted: Fastify matches these as two distinct routes.
    const published = (icao?: string) =>
      app.inject({ method: "GET", url: icao ? `/api/v1/vatsim/atis/${icao}` : "/api/v1/vatsim/atis" });

    it("creates the airport's record, and replaces it when the same body comes again", async () => {
      expect((await put("YSSY")).statusCode).toBe(201);
      const again = await put("YSSY");
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ icao: "YSSY", atis_letter: "N", issued: "120914" });
      expect((await published()).json()).toHaveLength(1);
    });

    it("serves the sections in editor order and the change list in it too", async () => {
      await put("YSSY");
      const atis = (await published("yssy")).json();
      expect(Object.keys(atis.content))
        .toEqual(["APCH", "RWY", "SFC COND", "OPR INFO", "WIND", "VIS", "WX", "CLD", "TMP", "QNH", "SIGWX"]);
      expect(atis.content.RWY).toBe("34L FOR ARRS, RWY 34R FOR DEPS");
      expect(atis.content.APCH).toBeNull();
      expect(atis.changed).toEqual(["WIND", "QNH"]);
    });

    it("tells the publisher who it recorded, and tells nobody else", async () => {
      const answer = (await put("YSSY")).json();
      expect(answer.controller).toEqual({ callsign: "SY_TWR", cid: 1234567 });
      expect(answer.client).toEqual({ name: "vatSys ATIS Plugin", version: "4.3" });
      // The broadcast is public; the controller behind it and the build they run are not.
      const read = (await published()).json()[0];
      expect(read).not.toHaveProperty("controller");
      expect(read).not.toHaveProperty("client");
    });

    it("keeps a zulu broadcast's text as its content", async () => {
      await put("YSCB", {
        ...sydney, icao: "YSCB", callsign: "YSCB_ATIS", atis_letter: "Z", type: "zulu",
        content: "CANBERRA TOWER IS CLOSED ... CONTACT CANBERRA APPROACH ON 124.500 ...", changed: []
      });
      expect((await published("YSCB")).json().content).toBe("CANBERRA TOWER IS CLOSED ... CONTACT CANBERRA APPROACH ON 124.500 ...");
    });

    it("refuses a body that contradicts its URL, or carries no letter, and stores neither", async () => {
      expect((await put("YMML")).statusCode).toBe(422);
      expect((await put("YSSY", { ...sydney, atis_letter: "" })).statusCode).toBe(422);
      expect((await published()).json()).toEqual([]);
    });

    it("expires an ATIS nobody has published again, and keeps a re-published one", async () => {
      await put("YSSY");
      await db.query("UPDATE network_atis SET received_at=now()-interval '91 minutes'");
      await runMaintenance();
      expect((await published()).json()).toEqual([]);
      // Re-publishing is what keeps it alive: the same body again resets the clock.
      await put("YSSY");
      await runMaintenance();
      expect((await published()).json()).toHaveLength(1);
    });

    it("is drawn on the map at its airport, letter, sections and all", async () => {
      await put("YSSY");
      const markers = (await app.inject({ method: "GET", url: "/api/v1/map/atis?server=live" })).json();
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        icao: "YSSY", atis_letter: "N", type: "atis", frequency: "126.250", issued: "120914",
        changed: ["WIND", "QNH"], lat: -33.94, lon: 151.18
      });
      expect(markers[0].content.QNH).toBe("1013");
    });

    it("shares the map with the vatSys ATIS pushed for an airport that has none published", async () => {
      // What an OzServer controller's own vatSys pushes (POST /atis), for an airport with no
      // published ATIS: same shape on the map, frequency converted out of its FSD form.
      await post("/atis", primary, { icao: "YBBN", atis_letter: "C", frequency: 32500, content: { QNH: "1012", MODE: "01" } });
      await put("YSSY");
      const markers = (await app.inject({ method: "GET", url: "/api/v1/map/atis?server=live" })).json();
      expect(markers.map((marker: { icao: string }) => marker.icao).sort()).toEqual(["YBBN", "YSSY"]);
      const brisbane = markers.find((marker: { icao: string }) => marker.icao === "YBBN");
      expect(brisbane).toMatchObject({ atis_letter: "C", frequency: "132.500", changed: [] });
      expect(brisbane.content).not.toHaveProperty("MODE");
      expect(brisbane.content.QNH).toBe("1012");
    });

    it("cannot be withdrawn - time is the only thing that takes one down", async () => {
      await put("YSSY");
      expect((await app.inject({ method: "DELETE", url: "/api/v1/vatsim/atis/YSSY" })).statusCode).toBe(404);
      expect((await published("YSSY")).json()).toMatchObject({ icao: "YSSY" });
    });
  });

  describe("console messages", () => {
    const send = (payload: Record<string, unknown>, token: string | null = consoleToken) => app.inject({
      method: "POST", url: "/api/v1/admin/messages", payload: { sent_by: "Dev", ...payload },
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    const sent = async () => (await app.inject({
      method: "GET", url: "/api/v1/admin/messages", headers: { authorization: `Bearer ${consoleToken}` }
    })).json() as Array<{ id: number; receipts: Array<{ callsign: string; read_at: string | null }>; replies: Array<{ callsign: string; body: string }> }>;
    const waiting = async (who: Identity) => (await get("/messages", who)).json() as Array<{ id: number; title: string }>;

    beforeEach(async () => {
      await db.query("TRUNCATE developer_messages CASCADE");
    });

    it("is closed to anyone without the console token", async () => {
      expect((await send({ title: "Hi", body: "There" }, null)).statusCode).toBe(401);
      expect((await send({ title: "Hi", body: "There" }, "wrong-token-wrong-token-wrong")).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/v1/admin/messages" })).statusCode).toBe(401);
    });

    it("reaches everyone a broadcast is for, once each, and records who read it", async () => {
      const { id } = (await send({ title: "Notice", body: "Restart vatSys", server: "live" })).json();
      expect((await waiting(primary)).map(m => m.id)).toEqual([id]);
      expect((await waiting({ ...third, server: "sb1" }))).toEqual([]);

      expect((await post(`/messages/${id}/read`, primary)).statusCode).toBe(204);
      expect(await waiting(primary)).toEqual([]);
      expect((await waiting(extender)).map(m => m.id)).toEqual([id]);

      const [message] = await sent();
      expect(message?.receipts.map(r => [r.callsign, r.read_at !== null]).sort())
        .toEqual([["XX-FAR_CTR", false], ["XX-GRP_CTR", true]]);
    });

    it("goes only to the callsigns it is addressed to, and needs no title", async () => {
      expect((await send({ body: "Only GRP and OTH", callsigns: ["xx-grp_ctr", "XX-OTH_CTR"] })).statusCode).toBe(201);
      expect(await waiting(primary)).toEqual([expect.objectContaining({ title: "" })]);
      expect(await waiting(third)).toHaveLength(1);
      expect(await waiting(extender)).toEqual([]);
    });

    it("lists the controllers connected now, for the console to address", async () => {
      await get("/messages", primary);
      await get("/messages", { ...third, server: "sb1" });
      const clients = async (server: string) => (await app.inject({
        method: "GET", url: `/api/v1/admin/clients?server=${server}`, headers: { authorization: `Bearer ${consoleToken}` }
      })).json() as Array<{ callsign: string; server: string }>;
      expect((await clients("live")).map(c => c.callsign)).toContain("XX-GRP_CTR");
      expect((await clients("live")).map(c => c.callsign)).not.toContain("XX-OTH_CTR");
      expect((await clients("all")).map(c => c.callsign)).toEqual(expect.arrayContaining(["XX-GRP_CTR", "XX-OTH_CTR"]));
    });

    it("takes a reply only when the sender asked for one", async () => {
      const closed = (await send({ title: "FYI", body: "No answer needed", allow_reply: false })).json().id;
      const open = (await send({ title: "Question", body: "Seen this?" })).json().id;
      expect((await post(`/messages/${closed}/reply`, primary, { body: "ok" })).statusCode).toBe(403);
      expect((await post(`/messages/${open}/reply`, primary, { body: "Yes, at 0630" })).statusCode).toBe(201);

      const question = (await sent()).find(m => m.id === open);
      expect(question?.replies).toMatchObject([{ callsign: "XX-GRP_CTR", body: "Yes, at 0630" }]);
      // Answering it is reading it.
      expect(await waiting(primary)).toEqual([expect.objectContaining({ id: closed })]);
    });

    it("stops reaching anyone once withdrawn", async () => {
      const { id } = (await send({ title: "Oops", body: "Wrong channel" })).json();
      expect((await app.inject({
        method: "POST", url: `/api/v1/admin/messages/${id}/withdraw`, headers: { authorization: `Bearer ${consoleToken}` }
      })).statusCode).toBe(204);
      expect(await waiting(primary)).toEqual([]);
    });
  });

  describe("controllers connected without the plugin", () => {
    // Never calls the API itself: only seen in other controllers' reports.
    const outsider = "XX-EXT_CTR";
    const report = (who: Identity, controllers: Array<Record<string, unknown>>) =>
      post("/network/controllers", who, { controllers });
    const controlled = async (who: Identity) =>
      ((await get("/sectors/sync", who)).json().controlled as Array<{ name: string; owner: { callsign: string; external?: boolean } }>);

    afterEach(async () => {
      await db.query("TRUNCATE network_controllers");
      (await import("./external-control.js")).invalidateExternalHoldings("live");
    });

    it("holds what their information lines and their frequencies say they work", async () => {
      expect((await report(third, [{ callsign: outsider, frequencies: ["128.400"], sectors: [], atis: ["Extending INA"] }])).statusCode).toBe(204);
      const held = await controlled(primary);
      expect(held.filter(row => row.owner.external).map(row => row.name).sort()).toEqual(["FAR", "INA"]);
      expect(held.find(row => row.name === "INA")?.owner).toMatchObject({ callsign: outsider, external: true });
    });

    it("holds every subsector of a group they extend onto, except one someone else is working", async () => {
      await report(third, [{ callsign: outsider, frequencies: [], sectors: [], atis: ["Extending GRP"] }]);
      const external = async () => Object.fromEntries((await controlled(primary))
        .filter(row => row.owner.external).map(row => [row.name, row.owner.callsign]));
      expect(await external()).toEqual({ GRP: outsider, INA: outsider, OUT: outsider });

      // Somebody else without the plugin, working INA, keeps it.
      await report(third, [
        { callsign: outsider, frequencies: [], sectors: [], atis: ["Extending GRP"] },
        { callsign: "XX-SUB_CTR", frequencies: [], sectors: ["INA"], atis: [] }
      ]);
      (await import("./external-control.js")).invalidateExternalHoldings("live");
      expect(await external()).toEqual({ GRP: outsider, INA: "XX-SUB_CTR", OUT: outsider });
    });

    it("cannot be claimed or requested from them", async () => {
      await report(third, [{ callsign: outsider, frequencies: ["128.400"], sectors: [], atis: ["Extending INA"] }]);
      const claim = await post("/sectors/INA/claim", primary);
      expect(claim.statusCode).toBe(409);
      expect(claim.json().conflicts[0]).toMatchObject({ sector: "INA", owner: { callsign: outsider, external: true } });
      // As a conflict in the group around it too: a claim of GRP does not take INA off them.
      const group = await post("/sectors/GRP/claim", primary);
      expect(group.statusCode).toBe(409);
      expect(group.json().conflicts.map((c: { sector: string }) => c.sector)).toEqual(["INA"]);
      const request = await post("/sectors/FAR/request", primary);
      expect(request.statusCode).toBe(409);
      expect(request.json().message).toMatch(/not using the OzServer plugin/);
    });

    it("leaves alone a controller who runs the plugin, and a sector someone on OzServer holds", async () => {
      await post("/sectors/FAR/claim", extender);
      await report(third, [
        { callsign: primary.callsign, frequencies: [], sectors: ["INA"], atis: [] },
        { callsign: outsider, frequencies: ["128.400"], sectors: [], atis: [] }
      ]);
      await get("/sectors/sync", primary);
      expect((await controlled(third)).filter(row => row.owner.external)).toEqual([]);
    });

    it("never counts a plugin user who has left, or dropped, as working without it", async () => {
      // Left a minute ago (release-all), still in another plugin's vatSys list.
      const leaver: Identity = { cid: 1000010, callsign: "XX-INA_CTR" };
      await post("/sectors/release-all", leaver);
      await db.query("UPDATE plugin_clients SET last_seen_at=now()-interval '1 minute' WHERE controller_cid=$1", [leaver.cid]);
      // Dropped: still owning FAR, quiet for a minute.
      await post("/sectors/FAR/claim", extender);
      await goQuiet(extender);
      await db.query("UPDATE plugin_clients SET last_seen_at=now()-interval '1 minute' WHERE controller_cid=$1", [extender.cid]);
      await report(third, [
        { callsign: leaver.callsign, frequencies: [], sectors: ["INA"], atis: [] },
        { callsign: extender.callsign, frequencies: ["128.400"], sectors: ["FAR"], atis: [] }
      ]);
      expect((await controlled(third)).filter(row => row.owner.external)).toEqual([]);
    });
  });

  it("limits how fast one address may call", async () => {
    const limited = await (await import("./app.js")).buildApp();
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 320; attempt++) {
        statuses.push((await limited.inject({ method: "GET", url: "/api/v1/servers" })).statusCode);
      }
      expect(statuses.slice(0, 300).every(status => status === 200)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
      // The health check is what the deploy gates on, and must never be turned away.
      expect((await limited.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
