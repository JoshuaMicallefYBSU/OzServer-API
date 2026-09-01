import pg from "pg";
import { config } from "./config.js";
import { pool } from "./db.js";

// Clients are told *that* something changed, never what. Every client re-reads through the
// authenticated endpoint it already uses, which keeps this channel free of anything sensitive - so
// it needs no auth of its own, and the browser map (whose EventSource cannot set an Authorization
// header) can share it - and means no DTO is duplicated here to drift out of step with its route.
export type OzEvent = { type: "sectors" | "fdr" | "atis" };

const CHANNEL = "ozserver_events";

type Client = { write: (chunk: string) => void };
const clients = new Set<Client>();

export function addClient(client: Client): () => void {
  clients.add(client);
  return () => clients.delete(client);
}

export function clientCount(): number {
  return clients.size;
}

function fanOut(event: OzEvent): void {
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

// Goes through NOTIFY rather than calling fanOut directly so that a second API container, or a
// one-off container command like dataset:sync, still reaches every connected client - not only the
// ones attached to whichever process happened to serve the mutation.
export async function publish(event: OzEvent): Promise<void> {
  try {
    await pool.query("SELECT pg_notify($1,$2)", [CHANNEL, JSON.stringify(event)]);
  } catch {
    // A failed notification must never fail the mutation that triggered it. Clients keep a slow
    // fallback poll precisely so a missed signal costs latency, not correctness.
  }
}

// LISTEN holds its connection for the life of the process, so it cannot come from the pool -
// borrowing a pooled client would either pin it forever or lose the subscription on release.
export async function startEventListener(log: { error: (error: unknown) => void }): Promise<void> {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });

  client.on("notification", message => {
    if (message.channel !== CHANNEL || !message.payload) return;
    try {
      fanOut(JSON.parse(message.payload) as OzEvent);
    } catch {
      // Malformed payload is not worth tearing the listener down for.
    }
  });

  // Without this a dropped LISTEN connection leaves every subscriber silently frozen on a socket
  // that is still open - the worst failure mode available, since it looks connected.
  client.on("error", error => {
    log.error(error);
    setTimeout(() => void startEventListener(log).catch(retryError => log.error(retryError)), 2_000);
  });

  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);
}
