import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  WEBSITE_ORIGIN: z.string().url().default("https://ozserver.org"),
  // How long a claim to a sector nobody has actively picked up is held in reserve before
  // runMaintenance releases it (and hands it up to a covering parent position, if one is staffed) -
  // see maintenance.ts. Deliberately NOT what decides whether a *different* controller may claim it
  // in the meantime; see PRESENCE_TIMEOUT_SECONDS for that.
  DISCONNECT_GRACE_MINUTES: z.coerce.number().positive().default(5),
  // How long without a request from a controller's own client before claimGroup stops treating
  // their sector_ownerships row as still actively held, for the purpose of letting someone ELSE
  // claim it outright. Short on purpose: every connected client heartbeats this server at least
  // every 10s regardless of what it's doing (the sectors-window poll alone), so a controller who
  // actually crashed or dropped should not keep a sector another controller wants to pick up right
  // now locked to them for the full DISCONNECT_GRACE_MINUTES - that window exists to eventually
  // hand an unclaimed sector to a covering parent and to protect resume, not to block a direct
  // claim. Generous enough to tolerate one missed poll tick or a slow response, short enough that
  // "immediately" is what it feels like to the controller waiting to pick it up.
  PRESENCE_TIMEOUT_SECONDS: z.coerce.number().positive().default(30),
  RESUME_WINDOW_MINUTES: z.coerce.number().positive().default(5),
  FDR_RETAIN_MINUTES: z.coerce.number().positive().default(15),
  ATIS_RETAIN_MINUTES: z.coerce.number().positive().default(90)
});

export const config = schema.parse(process.env);
