import type pg from "pg";
import type { ControllerIdentity } from "./types.js";

export async function writeDiagnosticLog(
  client: pg.Pool | pg.PoolClient,
  identity: ControllerIdentity,
  category: string,
  message: string,
  context: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO client_logs
       (controller_cid,controller_callsign,category,message,logged_at,plugin_version,context)
     VALUES ($1,$2,$3,$4,now(),'server',$5)`,
    [identity.cid, identity.callsign, category, message, JSON.stringify(context)]);
}
