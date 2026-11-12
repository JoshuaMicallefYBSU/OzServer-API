import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// End-to-end tests of the routes against a real Postgres - the claim, transfer, resume and sweep
// rules are almost entirely SQL plus the order things happen in, so there is very little of them
// that a test without a database would actually be testing.
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

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    // Short, so the startup grace that suspends presence checks and the sweep (see presence.ts) is
    // over after the wait below - but long enough that "just claimed" still reads as present on a
    // slow CI runner.
    process.env.PRESENCE_TIMEOUT_SECONDS = "2";
    process.env.DISCONNECT_GRACE_MINUTES = "0.05";

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
    await db.query("TRUNCATE sector_ownerships, sector_requests, flight_data_records, annotations, client_logs, resume_snapshots, network_atis, atis_broadcasts");
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

  it("lets a sector be claimed once its owner has gone quiet", async () => {
    await post("/sectors/INA/claim", extender);
    await goQuiet(extender);
    expect((await post("/sectors/INA/claim", third)).statusCode).toBe(201);
    expect(await mine(third)).toEqual(["INA"]);
  });

  describe("a primary logging on over a controller who extended into its airspace", () => {
    beforeEach(async () => {
      await post("/sectors/INA/claim", extender);
      await post("/sectors/OUT/claim", extender);
    });

    it("takes back its own position but not the rest of what it covers", async () => {
      const first = await post("/sectors/GRP/claim", primary, { primary_group: ["GRP", "INA"] });
      expect(first.statusCode).toBe(409);
      expect(first.json().conflicts.map((conflict: { sector: string }) => conflict.sector)).toEqual(["OUT"]);

      expect((await post("/sectors/GRP/claim", primary, { primary_group: ["GRP", "INA"], exclude: ["OUT"] })).statusCode).toBe(201);
      expect(await mine(primary)).toEqual(["GRP", "INA"]);
      expect(await mine(extender)).toEqual(["OUT"]);
    });

    it("still claims covered airspace nobody present is working", async () => {
      await goQuiet(extender);
      expect((await post("/sectors/GRP/claim", primary, { primary_group: ["GRP", "INA"] })).statusCode).toBe(201);
      expect(await mine(primary)).toEqual(["GRP", "INA", "OUT"]);
    });

    it("keeps the old everything-it-covers override for a client that sends no group", async () => {
      expect((await post("/sectors/GRP/claim", primary)).statusCode).toBe(201);
      expect(await mine(primary)).toEqual(["GRP", "INA", "OUT"]);
    });

    it("clears requests left pointing at the controller it took the sector from", async () => {
      expect((await post("/sectors/INA/request", third)).statusCode).toBe(201);
      await post("/sectors/GRP/claim", primary, { primary_group: ["GRP", "INA"], exclude: ["OUT"] });
      expect((await get("/sector-requests", third)).json().by_me).toEqual([]);
      // Which is what lets them ask the new owner instead.
      expect((await post("/sectors/INA/request", third)).statusCode).toBe(201);
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

  it("answers malformed ids and bodies as client errors, not server faults", async () => {
    expect((await post("/sector-requests/not-a-number/accept", extender)).statusCode).toBe(403);
    expect((await post("/sector-requests/not-a-number/reject", extender)).statusCode).toBe(403);
    expect((await post("/sector-requests/accept-batch", extender, { request_ids: "1,2" })).statusCode).toBe(422);
    expect((await post("/sectors/INA/claim", extender, { exclude: "INA" })).statusCode).toBe(422);
    expect((await post("/annotations/not-a-uuid/delete", extender)).statusCode).toBe(403);
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
  });

  describe("shared markup", () => {
    const note = { kind: "note", body: "hold here", points: [{ lat: -33.9, lon: 151.2 }] };
    const age = (seconds: number) => db.query(
      "UPDATE annotations SET last_seen_online_at=now()-($1*interval '1 second')", [seconds]);
    const count = async () => Number((await db.query("SELECT count(*) AS count FROM annotations")).rows[0].count);

    it("is kept alive by any request its author makes", async () => {
      expect((await post("/annotations", extender, note)).statusCode).toBe(201);
      await age(40);
      await get("/sectors/sync", extender);
      await runMaintenance();
      expect(await count()).toBe(1);
    });

    it("expires once its author has stopped calling", async () => {
      await post("/annotations", extender, note);
      await age(40);
      await runMaintenance();
      expect(await count()).toBe(0);
    });

    it("can only be removed by its author", async () => {
      const id = (await post("/annotations", extender, note)).json().id;
      expect((await post(`/annotations/${id}/delete`, third)).statusCode).toBe(403);
      expect((await post(`/annotations/${id}/delete`, extender)).statusCode).toBe(204);
    });
  });

  it("sweeps a controller who stopped calling and hands their sector to the group above it", async () => {
    await post("/sectors/GRP/claim", primary, { exclude: ["INA"] });
    await post("/sectors/INA/claim", extender);
    await goQuiet(extender);
    await runMaintenance();
    expect(await mine(primary)).toEqual(["GRP", "INA", "OUT"]);
  });

  // PUT /vatsim/atis/:icao is how an ATIS reaches this server now - published by the vatSys ATIS
  // plugin rather than mirrored from VATSIM's datafeed, and with no controller identity in the
  // body, so it does not go through pluginAuth the way everything above does.
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
