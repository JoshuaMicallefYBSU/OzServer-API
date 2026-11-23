import pg from "pg";
import { config } from "./config.js";
import { pool } from "./db.js";
import { SERVERS, type Server } from "./auth.js";

// Clients are told that something changed, never what: each re-reads through the endpoint it
// already uses. That keeps this channel free of anything sensitive - so it needs no identity, and
// the browser map (whose EventSource cannot set request headers) can share it - and duplicates no
// DTO here. `server` is carried only to route an event to the right subscribers.
// "messages": a console message was sent or withdrawn (routes/messages.ts). Subscribers that do not
// know a name ignore it - the map does, and so does a plugin older than the message system.
// "arrivals": an Arrival List was reordered, or opened or closed somewhere (routes/arrivals.ts).
const EVENT_TYPES = ["sectors", "fdr", "atis", "messages", "arrivals"] as const;
export type OzEvent = { type: typeof EVENT_TYPES[number]; server: Server };

const CHANNEL = "ozserver_events";

type Client = { write: (chunk: string) => void; end: () => void; server: Server; ip: string };
const clients = new Set<Client>();

// A stream holds a socket and a heartbeat timer for as long as it stays open, and the endpoint is
// public, so both the total (MAX_EVENT_SUBSCRIBERS) and any one address's share are bounded. A
// controller has one stream from the plugin and perhaps a browser tab or two on the map.
const MAX_CLIENTS_PER_IP = 8;

export function canAddClient(ip: string): boolean {
  if (clients.size >= config.MAX_EVENT_SUBSCRIBERS) return false;
  let fromThisAddress = 0;
  for (const client of clients) if (client.ip === ip) fromThisAddress++;
  return fromThisAddress < MAX_CLIENTS_PER_IP;
}

export function addClient(client: Client): () => void {
  clients.add(client);
  return () => clients.delete(client);
}

export function clientCount(): number {
  return clients.size;
}

// Ends every open stream. An SSE response never finishes on its own and Fastify's close() waits
// for in-flight responses, so without this a shutdown would hang until Docker killed the process.
export function closeAllClients(): void {
  for (const client of [...clients]) {
    try {
      client.end();
    } catch {
      // Already gone.
    }
  }
  clients.clear();
}

// Tells every open stream, on every server, that this process is shutting down to restart - every
// deploy is one. The plugin holds back its "can't reach OzServer" errors until the API answers again
// (ApiOutage), rather than putting one in front of the controller for each call that fails meanwhile.
// Written straight to this process's own streams, not through NOTIFY: it is about this process.
// Must run before closeAllClients.
export function announceRestart(): void {
  const frame = `event: restarting\ndata: ${JSON.stringify({ type: "restarting" })}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      // Already gone.
    }
  }
}

function fanOut(event: OzEvent): void {
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    if (client.server !== event.server) continue;
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

// Goes through NOTIFY rather than calling fanOut directly, so a second API container or a one-off
// command like dataset:sync reaches every connected client, not only those attached to the process
// that made the change.
export async function publish(event: OzEvent): Promise<void> {
  try {
    await pool.query("SELECT pg_notify($1,$2)", [CHANNEL, JSON.stringify(event)]);
  } catch {
    // A failed notification must never fail the mutation that triggered it. Clients keep a slow
    // fallback poll, so a missed signal costs latency, not correctness.
  }
}

type Log = { error: (error: unknown) => void };

const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

let listener: pg.Client | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let stopped = false;

// LISTEN holds its connection for the life of the process, so it cannot come from the pool -
// borrowing a pooled client would either pin it forever or lose the subscription on release.
//
// Never rejects, and never gives up: a dropped LISTEN connection leaves every subscriber frozen on
// a socket that still looks connected. pg reports a failed connect through the returned promise
// and a later drop through the 'error' or 'end' event, so every failure, at any stage, goes through
// the same path (`fail` in connectListener) and schedules the next attempt.
export async function startEventListener(log: Log): Promise<void> {
  stopped = false;
  await connectListener(log, MIN_RETRY_MS, false);
}

export async function stopEventListener(): Promise<void> {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const client = listener;
  listener = null;
  if (client) await client.end().catch(() => undefined);
}

async function connectListener(log: Log, retryDelay: number, isReconnect: boolean): Promise<void> {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  let connected = false;
  let failed = false;

  const fail = (error?: unknown) => {
    if (failed) return;
    failed = true;
    if (error) log.error(error);
    if (listener === client) listener = null;
    // The connection is being abandoned; anything it still has to say is not worth a crash.
    client.removeAllListeners();
    client.on("error", () => undefined);
    void client.end().catch(() => undefined);
    if (stopped || retryTimer) return;
    // Back off while it keeps failing, but start again from the minimum after a connection that
    // worked - that one dropping is a fresh problem, not a continuation of the last.
    const delay = connected ? MIN_RETRY_MS : retryDelay;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connectListener(log, Math.min(delay * 2, MAX_RETRY_MS), true);
    }, delay);
    retryTimer.unref();
  };

  client.on("notification", message => {
    if (message.channel !== CHANNEL || !message.payload) return;
    try {
      fanOut(JSON.parse(message.payload) as OzEvent);
    } catch {
      // Malformed payload is not worth tearing the listener down for.
    }
  });
  client.on("error", fail);
  client.on("end", () => fail());

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
  } catch (error) {
    fail(error);
    return;
  }

  if (stopped) {
    void client.end().catch(() => undefined);
    return;
  }

  connected = true;
  listener = client;

  // Whatever was published while nothing was listening is gone - NOTIFY is not queued for an
  // absent listener - so every subscriber is told to re-read everything once.
  if (isReconnect) {
    for (const server of SERVERS) {
      for (const type of EVENT_TYPES) fanOut({ type, server });
    }
  }
}
