import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { publish } from "../events.js";
import { externalHoldings, holdingsSignature, invalidateExternalHoldings, isControllerCallsign, noteNetworkReport } from "../external-control.js";

// The controllers a plugin's vatSys can see, for working out whose airspace is held by someone
// without the plugin (external-control.ts). Each plugin reports every NetworkReportInterval (15 s)
// and when its list changes; everyone it sees is sent, plugin users included, and sorted out on
// read.
//
// The text in it is other controllers' - a name, a line of controller information - and is cut to
// length rather than refused. One controller anywhere on the network with a long information line
// would otherwise have every plugin that could see them refused outright, report after report, and
// on a SweatBox, where these reports are all there is, every holding with them.
const cut = (length: number) => z.string().transform(value => value.slice(0, length));
const reportSchema = z.object({
  controllers: z.array(z.object({
    callsign: z.string().trim().min(3).max(32).transform(value => value.toUpperCase()),
    real_name: cut(64).nullish(),
    frequencies: z.array(z.string().max(16)).max(32).default([]),
    sectors: z.array(z.string().max(32)).max(200).default([]),
    // Their controller information lines ("Extending MUN, GUN") - see atisSectors.
    atis: z.array(cut(256)).transform(lines => lines.slice(0, 40)).default([])
  })).max(1000)
});

// What the holdings last were on each server, so a report that changes nothing announces nothing.
const lastSignature = new Map<string, string>();

export async function networkRoutes(app: FastifyInstance): Promise<void> {
  app.post("/network/controllers", async (request, reply) => {
    const parsed = reportSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(422).send({ message: "Invalid controller report.", errors: parsed.error.flatten() });
    const { server, cid } = request.controller;

    // Whatever it saw, even nobody: a controller this plugin has stopped listing has logged off
    // (external-control.ts), and that is told from its reports going on without them.
    noteNetworkReport(server, cid);

    // One row per callsign, in one statement: a statement may not touch the same row twice, and a
    // plugin on a busy night lists hundreds.
    const controllers = [...new Map(parsed.data.controllers
      .filter(controller => isControllerCallsign(controller.callsign))
      .map(controller => [controller.callsign, {
        callsign: controller.callsign, real_name: controller.real_name ?? null,
        frequencies: controller.frequencies, sectors: controller.sectors, atis: controller.atis
      }])).values()];
    if (controllers.length > 0) {
      await pool.query(
        `INSERT INTO network_controllers (server,callsign,real_name,frequencies,sectors,atis,reported_by_cid,last_seen_at)
         SELECT $1,c.callsign,c.real_name,c.frequencies,c.sectors,c.atis,$3,now()
           FROM jsonb_to_recordset($2::jsonb) AS c(callsign text, real_name text, frequencies jsonb, sectors jsonb, atis jsonb)
         ON CONFLICT (server,callsign) DO UPDATE SET real_name=excluded.real_name, frequencies=excluded.frequencies,
           sectors=excluded.sectors, atis=excluded.atis, reported_by_cid=excluded.reported_by_cid, last_seen_at=now()`,
        [server, JSON.stringify(controllers), cid]);
    }

    invalidateExternalHoldings(server);
    const external = await externalHoldings(pool, server);
    const signature = holdingsSignature(external.holdings);
    if (lastSignature.has(server) && lastSignature.get(server) !== signature) await publish({ type: "sectors", server });
    lastSignature.set(server, signature);
    return reply.code(204).send();
  });
}
