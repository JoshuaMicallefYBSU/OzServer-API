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
    await db.query("TRUNCATE sector_ownerships, sector_requests, flight_data_records, annotations, client_logs, resume_snapshots");
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
