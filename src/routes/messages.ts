import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseServer, SERVERS, tokenMatches, type Server } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { publish } from "../events.js";

// Developer messages: notices sent from the website's /console to controllers' plugins, which the
// controller can answer when the sender allows it.
//
//   - The console (through the website's server, which holds CONSOLE_TOKEN) sends, lists and
//     withdraws messages under /admin/messages. Never open: without CONSOLE_TOKEN those routes
//     answer 404, as if they did not exist.
//   - The plugin fetches what is waiting for it (GET /messages), marks it read, and replies.
//
// A message goes either to everyone on a server (or every server) - shown to whoever is connected
// and to anyone who connects before it expires - or to chosen callsigns, picked in the console from
// the controllers connected at the time, and to nobody else. It is shown once per controller
// session identity (cid, callsign, server): read, it is not shown again. Sending one publishes a
// "messages" event, so plugins fetch at once rather than at their next poll.

const MAX_TITLE = 120;
const MAX_BODY = 2000;
const MAX_REPLY = 1000;
const DEFAULT_SENDER = "OzServer Development Team";
// A broadcast: five minutes to a week, fifteen by default.
const expiresSchema = z.coerce.number().int().min(5).max(7 * 24 * 60).default(15);
// A message to chosen controllers has no "show for": it is theirs whenever their plugin next asks,
// within a day - long enough to reach someone who drops and reconnects.
const TARGETED_MINUTES = 24 * 60;
// A plugin call this recent counts as connected, for the console's recipient list.
const CONNECTED_MINUTES = 2;

const sendSchema = z.object({
  // Optional: a short notice can be all body.
  title: z.string().trim().max(MAX_TITLE).default(""),
  body: z.string().trim().min(1).max(MAX_BODY),
  // Omitted, null or "all": every server.
  server: z.union([z.enum(SERVERS), z.literal("all"), z.null()]).optional(),
  // Omitted, null or empty: everyone.
  callsigns: z.array(z.string().trim().min(1).max(32)).max(100).nullable().optional(),
  allow_reply: z.boolean().default(true),
  expires_minutes: expiresSchema,
  sent_by: z.string().trim().min(1).max(40).default(DEFAULT_SENDER)
});

const replySchema = z.object({ body: z.string().trim().min(1).max(MAX_REPLY) });
const idSchema = z.coerce.number().int().positive();
const sinceSchema = z.coerce.number().int().min(1).max(30).default(7);

type MessageRow = {
  id: string;
  title: string;
  body: string;
  server: string | null;
  target_callsigns: string[] | null;
  allow_reply: boolean;
  sent_by: string;
  created_at: Date;
  expires_at: Date;
  withdrawn_at: Date | null;
};

const forPlugin = (row: MessageRow) => ({
  id: Number(row.id),
  title: row.title,
  body: row.body,
  allow_reply: row.allow_reply,
  sent_by: row.sent_by,
  created_at: row.created_at
});

// The servers a message's event goes to: its own, or every one.
async function announce(server: string | null): Promise<void> {
  const servers: readonly Server[] = server ? [parseServer(server)].filter((s): s is Server => s !== null) : SERVERS;
  for (const target of servers) await publish({ type: "messages", server: target });
}

// Visible to this controller: on their server (or all), for them (or everyone), still current.
const VISIBLE = `m.withdrawn_at IS NULL
  AND (m.server IS NULL OR m.server = $1)
  AND (m.target_callsigns IS NULL OR upper($2) = ANY(m.target_callsigns))`;

export async function protectedMessageRoutes(app: FastifyInstance): Promise<void> {
  // What is waiting for this controller: current messages they have not read. Recorded as delivered
  // as it is handed out. An expired message still reaches a controller it was already delivered to
  // and who has not read it - they may have had it open when it expired.
  app.get("/messages", async request => {
    const { cid, callsign, server } = request.controller;
    const rows = (await pool.query<MessageRow>(
      `SELECT m.* FROM developer_messages m
        LEFT JOIN developer_message_receipts r
          ON r.message_id=m.id AND r.server=$1 AND r.controller_callsign=$2 AND r.controller_cid=$3
        WHERE ${VISIBLE}
          AND r.read_at IS NULL
          AND (m.expires_at > now() OR r.message_id IS NOT NULL)
        ORDER BY m.created_at`,
      [server, callsign, cid])).rows;

    if (rows.length > 0) {
      await pool.query(
        `INSERT INTO developer_message_receipts (message_id,controller_cid,controller_callsign,server)
         SELECT unnest($1::bigint[]),$2,$3,$4
         ON CONFLICT (message_id,server,controller_callsign,controller_cid) DO NOTHING`,
        [rows.map(row => row.id), cid, callsign, server]);
    }
    return rows.map(forPlugin);
  });

  app.post<{ Params: { id: string } }>("/messages/:id/read", async (request, reply) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ message: "Invalid message id." });
    const { cid, callsign, server } = request.controller;
    // Only a message this controller was sent: a receipt for any id, as this once wrote, showed the
    // console a message read by someone it never went to. Withdrawn ones included - one already on
    // a controller's screen is still dismissed.
    await pool.query(
      `INSERT INTO developer_message_receipts (message_id,controller_cid,controller_callsign,server,read_at)
       SELECT m.id,$2,$3,$4,now() FROM developer_messages m
        WHERE m.id=$1 AND (m.server IS NULL OR m.server = $4)
          AND (m.target_callsigns IS NULL OR upper($3) = ANY(m.target_callsigns))
       ON CONFLICT (message_id,server,controller_callsign,controller_cid) DO UPDATE SET read_at=COALESCE(developer_message_receipts.read_at, now())`,
      [id.data, cid, callsign, server]);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/messages/:id/reply", async (request, reply) => {
    const id = idSchema.safeParse(request.params.id);
    const body = replySchema.safeParse(request.body ?? {});
    if (!id.success || !body.success) return reply.code(422).send({ message: `A reply needs some text, at most ${MAX_REPLY} characters.` });
    const { cid, callsign, server } = request.controller;

    // Only a message this controller can see, that asks for replies. Not refused for having expired:
    // a reply typed while it was open must still arrive.
    const message = (await pool.query<{ allow_reply: boolean }>(
      `SELECT m.allow_reply FROM developer_messages m WHERE m.id=$3 AND ${VISIBLE}`,
      [server, callsign, id.data])).rows[0];
    if (!message) return reply.code(404).send({ message: "That message is no longer available." });
    if (!message.allow_reply) return reply.code(403).send({ message: "That message does not take replies." });

    await pool.query(
      `INSERT INTO developer_message_replies (message_id,controller_cid,controller_callsign,server,body) VALUES ($1,$2,$3,$4,$5)`,
      [id.data, cid, callsign, server, body.data.body]);
    // Answering it is reading it.
    await pool.query(
      `INSERT INTO developer_message_receipts (message_id,controller_cid,controller_callsign,server,read_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (message_id,server,controller_callsign,controller_cid) DO UPDATE SET read_at=COALESCE(developer_message_receipts.read_at, now())`,
      [id.data, cid, callsign, server]);
    return reply.code(201).send({ sent: true });
  });
}

// CONSOLE_TOKEN, as a bearer token. 404 rather than 401 when it is not configured, so an API
// without it does not advertise the routes at all.
async function consoleAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.CONSOLE_TOKEN) return reply.code(404).send({ message: "Not found." });
  const header = request.headers.authorization;
  const presented = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
  if (!tokenMatches(presented, config.CONSOLE_TOKEN)) {
    return reply.code(401).send({ message: "A valid console token is required." });
  }
}

export async function adminMessageRoutes(app: FastifyInstance): Promise<void> {
  // Its own encapsulated context, so the token hook covers these routes and nothing else public.
  await app.register(async admin => {
    admin.addHook("preHandler", consoleAuth);

    // Every message sent in the last `days` days, newest first, with who it reached and what they
    // answered.
    admin.get<{ Querystring: { days?: string } }>("/admin/messages", async (request, reply) => {
      const days = sinceSchema.safeParse(request.query.days);
      if (!days.success) return reply.code(400).send({ message: "days must be 1-30." });

      const messages = (await pool.query<MessageRow>(
        `SELECT * FROM developer_messages WHERE created_at >= now()-($1*interval '1 day') ORDER BY created_at DESC LIMIT 200`,
        [days.data])).rows;
      const ids = messages.map(message => message.id);
      const receipts = ids.length === 0 ? [] : (await pool.query<{
        message_id: string; controller_cid: number; controller_callsign: string; server: string;
        delivered_at: Date; read_at: Date | null;
      }>(
        `SELECT * FROM developer_message_receipts WHERE message_id = ANY($1::bigint[]) ORDER BY delivered_at`, [ids])).rows;
      const replies = ids.length === 0 ? [] : (await pool.query<{
        id: string; message_id: string; controller_cid: number; controller_callsign: string; server: string;
        body: string; created_at: Date;
      }>(
        `SELECT * FROM developer_message_replies WHERE message_id = ANY($1::bigint[]) ORDER BY created_at`, [ids])).rows;

      return messages.map(message => ({
        id: Number(message.id),
        title: message.title,
        body: message.body,
        server: message.server,
        callsigns: message.target_callsigns,
        allow_reply: message.allow_reply,
        sent_by: message.sent_by,
        created_at: message.created_at,
        expires_at: message.expires_at,
        withdrawn_at: message.withdrawn_at,
        receipts: receipts.filter(r => r.message_id === message.id).map(r => ({
          cid: r.controller_cid, callsign: r.controller_callsign, server: r.server,
          delivered_at: r.delivered_at, read_at: r.read_at
        })),
        replies: replies.filter(r => r.message_id === message.id).map(r => ({
          id: Number(r.id), cid: r.controller_cid, callsign: r.controller_callsign, server: r.server,
          body: r.body, created_at: r.created_at
        }))
      }));
    });

    admin.post("/admin/messages", async (request, reply) => {
      const parsed = sendSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(422).send({ message: "Invalid message.", errors: parsed.error.flatten() });
      const { title, body, allow_reply, expires_minutes, sent_by } = parsed.data;
      const server = parsed.data.server && parsed.data.server !== "all" ? parsed.data.server : null;
      const chosen = [...new Set((parsed.data.callsigns ?? []).map(callsign => callsign.toUpperCase()))];
      const callsigns = chosen.length > 0 ? chosen : null;
      const minutes = callsigns ? TARGETED_MINUTES : expires_minutes;

      const row = (await pool.query<MessageRow>(
        `INSERT INTO developer_messages (title,body,server,target_callsigns,allow_reply,sent_by,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,now()+($7*interval '1 minute')) RETURNING *`,
        [title, body, server, callsigns, allow_reply, sent_by, minutes])).rows[0];
      await announce(server);
      request.log.info({ messageId: row?.id, server, callsigns, sentBy: sent_by }, "Console message sent.");
      return reply.code(201).send(row ? { id: Number(row.id), expires_at: row.expires_at } : {});
    });

    // Controllers whose plugin has called in the last CONNECTED_MINUTES, for the console's recipient
    // checklist. ?server= narrows it to one server.
    admin.get<{ Querystring: { server?: string } }>("/admin/clients", async (request, reply) => {
      const server = request.query.server && request.query.server !== "all" ? parseServer(request.query.server) : null;
      if (request.query.server && request.query.server !== "all" && server === null) {
        return reply.code(400).send({ message: "server must be live, sb1, sb2 or all." });
      }
      return (await pool.query<{ controller_callsign: string; controller_cid: number; server: string; last_seen_at: Date }>(
        `SELECT DISTINCT ON (server, upper(controller_callsign)) controller_callsign,controller_cid,server,last_seen_at
           FROM plugin_clients
          WHERE last_seen_at >= now()-($1*interval '1 minute') AND ($2::text IS NULL OR server = $2)
          ORDER BY server, upper(controller_callsign), last_seen_at DESC`,
        [CONNECTED_MINUTES, server])).rows.map(row => ({
          callsign: row.controller_callsign, cid: row.controller_cid, server: row.server, last_seen_at: row.last_seen_at
        }));
    });

    // Stops a message reaching anyone who has not had it yet. One already on a controller's screen
    // stays there.
    admin.post<{ Params: { id: string } }>("/admin/messages/:id/withdraw", async (request, reply) => {
      const id = idSchema.safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ message: "Invalid message id." });
      const row = (await pool.query<{ server: string | null }>(
        "UPDATE developer_messages SET withdrawn_at=COALESCE(withdrawn_at, now()) WHERE id=$1 RETURNING server",
        [id.data])).rows[0];
      if (!row) return reply.code(404).send({ message: "No such message." });
      await announce(row.server);
      return reply.code(204).send();
    });
  });
}
