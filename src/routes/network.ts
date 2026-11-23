import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { publish } from "../events.js";
import { externalHoldings, holdingsSignature, invalidateExternalHoldings, isControllerCallsign } from "../external-control.js";

// The controllers a plugin's vatSys can see, for working out whose airspace is held by someone
// without the plugin (external-control.ts). Each plugin reports every NetworkReportInterval (15 s)
// and when its list changes; everyone it sees is sent, plugin users included, and sorted out on
// read.
const reportSchema = z.object({
  controllers: z.array(z.object({
    callsign: z.string().trim().min(3).max(32).transform(value => value.toUpperCase()),
    real_name: z.string().max(64).nullish(),
    frequencies: z.array(z.string().max(16)).max(32).default([]),
    sectors: z.array(z.string().max(32)).max(200).default([]),
    // Their controller information lines ("Extending MUN, GUN") - see atisSectors.
    atis: z.array(z.string().max(256)).max(40).default([])
  })).max(300)
});

// What the holdings last were on each server, so a report that changes nothing announces nothing.
const lastSignature = new Map<string, string>();

export async function networkRoutes(app: FastifyInstance): Promise<void> {
  app.post("/network/controllers", async (request, reply) => {
    const parsed = reportSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(422).send({ message: "Invalid controller report.", errors: parsed.error.flatten() });
    const { server, cid } = request.controller;

    const controllers = parsed.data.controllers.filter(controller => isControllerCallsign(controller.callsign));
    for (const controller of controllers) {
      await pool.query(
        `INSERT INTO network_controllers (server,callsign,real_name,frequencies,sectors,atis,reported_by_cid,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (server,callsign) DO UPDATE SET real_name=excluded.real_name, frequencies=excluded.frequencies,
           sectors=excluded.sectors, atis=excluded.atis, reported_by_cid=excluded.reported_by_cid, last_seen_at=now()`,
        [server, controller.callsign, controller.real_name ?? null, JSON.stringify(controller.frequencies),
         JSON.stringify(controller.sectors), JSON.stringify(controller.atis), cid]);
    }

    invalidateExternalHoldings(server);
    const external = await externalHoldings(pool, server);
    const signature = holdingsSignature(external.holdings);
    if (lastSignature.has(server) && lastSignature.get(server) !== signature) await publish({ type: "sectors", server });
    lastSignature.set(server, signature);
    return reply.code(204).send();
  });
}
