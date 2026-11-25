import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

// An idle client whose connection dies - Postgres restarting, a backend terminated - is reported
// on the pool. With no listener that is an uncaught exception, and the API exited whenever the
// database was restarted under it. The pool has already discarded the client; the next query opens
// a new one.
pool.on("error", error => {
  console.error("Idle Postgres connection lost:", error.message);
});

export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
