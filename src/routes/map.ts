import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db.js";
import { afvTransceivers, vatsimData } from "../vatsim.js";

const visibleTypes = ["TWR", "APP", "DEP", "CTR", "FSS"];
const typePriority: Record<string, number> = { FMP: 0, CTR: 1, FSS: 1, APP: 2, DEP: 2, TWR: 3, GND: 3, DEL: 3 };

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.get("/map/sectors", async () => {
    const online = new Set((await vatsimData())?.controllers?.map(controller => controller.callsign.toUpperCase()) ?? []);
    return (await pool.query(
      `SELECT s.*,o.controller_cid,o.controller_callsign FROM sectors s
       JOIN sector_ownerships o ON o.sector_id=s.id WHERE s.type=ANY($1) ORDER BY s.name`, [visibleTypes])).rows.map(row => ({
        name: row.name, full_name: row.full_name, callsign: row.callsign, frequency: row.frequency,
        boundary: row.boundary, owner: { cid: row.controller_cid, callsign: row.controller_callsign },
        online: online.has(row.callsign?.toUpperCase())
      }));
  });
  app.get("/map/aircraft", async () => (await pool.query(
    `SELECT * FROM flight_data_records WHERE last_seen_at >= now()-($1*interval '1 minute')
      AND (data->>'lat') IS NOT NULL ORDER BY callsign`,
    [config.FDR_RETAIN_MINUTES])).rows.map(row => ({ ...row.data, callsign: row.callsign,
      controlling_cid: row.controlling_cid, controlling_callsign: row.controlling_callsign,
      current_sector: row.current_sector, last_seen_at: row.last_seen_at })));
  app.get("/map/atis", async () => (await pool.query(
    `SELECT a.*,p.default_lat AS lat,p.default_lon AS lon FROM atis_broadcasts a JOIN positions p ON p.asmgcs_airport=a.icao
      WHERE a.last_seen_at >= now()-($1*interval '1 minute')`, [config.ATIS_RETAIN_MINUTES])).rows);
  app.get("/map/controllers", async () => {
    const data = await vatsimData();
    const sectors = new Map((await pool.query("SELECT name,callsign,type FROM sectors WHERE callsign IS NOT NULL")).rows.map(row => [row.callsign, row]));
    const owners = new Set((await pool.query("SELECT DISTINCT controller_cid FROM sector_ownerships")).rows.map(row => row.controller_cid));
    const frequencies = new Map((await afvTransceivers()).map(entry => [entry.callsign,
      [...new Set((entry.transceivers ?? []).map(item => Math.round(item.frequency / 1000) / 1000))]]));
    return (data?.controllers ?? []).filter(controller => sectors.has(controller.callsign)).map(controller => {
      const sector = sectors.get(controller.callsign)!;
      return { cid: controller.cid, callsign: controller.callsign,
        frequencies: frequencies.get(controller.callsign) ?? [Number(controller.frequency)],
        sector_name: sector.name, type: sector.type, is_ozserver: owners.has(controller.cid) };
    }).sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99) || a.sector_name.localeCompare(b.sector_name));
  });
  app.get("/afv/transceivers", async () => afvTransceivers());
}
