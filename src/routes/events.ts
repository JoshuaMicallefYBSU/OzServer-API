import type { FastifyInstance } from "fastify";
import { addClient, clientCount } from "../events.js";

// Idle intermediaries drop a connection that sends nothing. A comment frame is ignored by every
// SSE client but keeps the socket alive.
const HEARTBEAT_MS = 20_000;

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/events", (request, reply) => {
    // Fastify must be told to stop managing this response, or it will try to send its own on top
    // of the stream we are about to write by hand.
    reply.hijack();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(": connected\n\n");

    const remove = addClient({ write: chunk => reply.raw.write(chunk) });
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
  });

  app.get("/events/status", async () => ({ subscribers: clientCount() }));
}
