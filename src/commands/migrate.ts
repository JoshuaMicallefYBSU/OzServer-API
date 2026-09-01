import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool, transaction } from "../db.js";

const directory = resolve(process.cwd(), "migrations");
await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
  const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
  if (exists.rowCount) continue;
  await transaction(async client => {
    await client.query(await readFile(resolve(directory, name), "utf8"));
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
  });
  console.log(`Applied ${name}`);
}
await pool.end();
