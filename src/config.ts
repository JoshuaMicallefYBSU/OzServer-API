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
  // idle poll (OzServerOwnershipTracker.PollInterval) is every 3s, so anything at or below that
  // would let a claim snipe a genuinely-connected, idle controller's sector just because their own
  // poll happened to land a little late - a worse bug than the one this fixes. 6s is that 3s floor
  // doubled for network jitter or one slow response, nothing more - keep this at roughly 2x
  // PollInterval if that ever changes again. A controller who actually crashed or dropped should
  // not keep a sector another controller wants to pick up right now locked to them for the full
  // DISCONNECT_GRACE_MINUTES - that window exists to eventually hand an unclaimed sector to a
  // covering parent and to protect resume, not to block a direct claim.
  PRESENCE_TIMEOUT_SECONDS: z.coerce.number().positive().default(6),
  RESUME_WINDOW_MINUTES: z.coerce.number().positive().default(5),
  FDR_RETAIN_MINUTES: z.coerce.number().positive().default(15),
  ATIS_RETAIN_MINUTES: z.coerce.number().positive().default(60),
  // How often network_atis is re-synced from the VATSIM datafeed (network-atis-sync.ts). The feed
  // itself only republishes every ~15s and vatsim.ts caches it for 15s, so going lower buys nothing.
  NETWORK_ATIS_SYNC_SECONDS: z.coerce.number().positive().default(30),
  // Requests one address may make in any ten seconds before it is answered 429 (see app.ts). A
  // connected plugin makes two or three a second at its busiest, and a map viewer about the same,
  // so this is roughly ten of either behind one address - far above honest use, far below a loop.
  RATE_LIMIT_PER_10S: z.coerce.number().int().positive().default(300),
  // Open /events streams the process will hold at once, across every address (see events.ts).
  MAX_EVENT_SUBSCRIBERS: z.coerce.number().int().positive().default(500),
  // When set, GET /client-logs requires it (Authorization: Bearer, or ?token=). Unset keeps the
  // endpoint public, which is how it has run so far - it returns every controller's CID, callsign
  // and decision log for the last day to anyone who asks, so set this once the console page can
  // send it.
  CLIENT_LOGS_TOKEN: z.string().trim().min(16).optional()
});

export const config = schema.parse(process.env);
