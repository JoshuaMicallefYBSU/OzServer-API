import type { FastifyInstance } from "fastify";
import { parseServer } from "../auth.js";
import { config } from "../config.js";
import { addClient, canAddClient, clientCount } from "../events.js";

// Idle intermediaries drop a connection that sends nothing. A comment frame is ignored by every
// SSE client but keeps the socket alive.
const HEARTBEAT_MS = 20_000;

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { server?: string } }>("/events", (request, reply) => {
    const server = parseServer(request.query.server);
    if (!server) return reply.code(400).send({ message: "A valid ?server= query parameter is required." });

    // See canAddClient: a subscriber that is turned away keeps working off its own fallback poll,
    // so refusing one costs latency and nothing else.
    if (!canAddClient(request.ip)) {
      return reply.code(503).header("Retry-After", "30").send({ message: "Too many event subscribers." });
    }

    // Fastify must be told to stop managing this response, or it will try to send its own on top
    // of the stream we are about to write by hand.
    reply.hijack();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // Set by hand because reply.hijack() takes this response out of Fastify's pipeline
      // entirely - @fastify/cors never gets to add it, and without it the browser silently
      // refuses the EventSource connection while curl sees a perfectly healthy stream.
      "Access-Control-Allow-Origin": config.WEBSITE_ORIGIN
    });
    reply.raw.write(": connected\n\n");

    const remove = addClient({
      write: chunk => reply.raw.write(chunk),
      end: () => reply.raw.end(),
      server,
      ip: request.ip
    });
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        // Socket already gone; the close handler below does the cleanup.
      }
    }, HEARTBEAT_MS);

    const close = () => {
      clearInterval(heartbeat);
      remove();
    };
    request.raw.on("close", close);
    request.raw.on("error", close);
    reply.raw.on("close", close);
  });

  app.get("/events/status", async () => ({ subscribers: clientCount() }));
}
