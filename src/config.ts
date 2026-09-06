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
  // claim it outright. As close to instant as is actually safe, not a moment longer: the plugin's
  // idle poll (OzServerOwnershipTracker.PollInterval) is every 10s, so anything at or below that
  // would let a claim snipe a genuinely-connected, idle controller's sector just because their own
  // poll happened to land a little late - a worse bug than the one this fixes. 15s is that 10s
  // floor plus a small margin for network jitter or one slow response, nothing more. A controller
  // who actually crashed or dropped should not keep a sector another controller wants to pick up
  // right now locked to them for the full DISCONNECT_GRACE_MINUTES - that window exists to
  // eventually hand an unclaimed sector to a covering parent and to protect resume, not to block a
  // direct claim.
  PRESENCE_TIMEOUT_SECONDS: z.coerce.number().positive().default(15),
  RESUME_WINDOW_MINUTES: z.coerce.number().positive().default(5),
  FDR_RETAIN_MINUTES: z.coerce.number().positive().default(15),
  ATIS_RETAIN_MINUTES: z.coerce.number().positive().default(90)
});

export const config = schema.parse(process.env);
