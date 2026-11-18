import { z } from "zod";
import { DISCORD_WEBHOOK_PATTERN } from "./discord.js";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  WEBSITE_ORIGIN: z.string().url().default("https://ozserver.org"),
  // Minutes a controller's sectors are held after their client stops calling, before runMaintenance
  // releases them (handing each to a covering parent position if one is staffed - see
  // maintenance.ts). Does not decide whether another controller may claim them in the meantime;
  // see PRESENCE_TIMEOUT_SECONDS.
  DISCONNECT_GRACE_MINUTES: z.coerce.number().positive().default(5),
  // Seconds without a request from a controller's client before they stop counting as present, at
  // which point another controller may claim their sectors outright (claimGroup). Keep at about
  // twice the plugin's 3 s idle poll (OzServerOwnershipTracker.PollInterval): at or below the poll
  // interval, a connected controller whose poll lands slightly late would lose a sector.
  PRESENCE_TIMEOUT_SECONDS: z.coerce.number().positive().default(6),
  RESUME_WINDOW_MINUTES: z.coerce.number().positive().default(5),
  // Minutes after a controller leaves (their last request if they dropped, or their release-all)
  // within which a different controller connecting under the same callsign takes over the
  // position: its sectors that the previous controller still held, with their tags inside them
  // (handOverPosition in routes/sectors.ts). Outside it, or for anything the previous controller was
  // extending into, the tags are left with nobody.
  POSITION_HANDOVER_MINUTES: z.coerce.number().positive().default(2),
  FDR_RETAIN_MINUTES: z.coerce.number().positive().default(15),
  ATIS_RETAIN_MINUTES: z.coerce.number().positive().default(60),
  // Minutes an ATIS published with PUT /api/v1/vatsim/atis/:icao is kept after its last PUT before
  // runMaintenance deletes it. There is no withdraw, so a record otherwise leaves only by being
  // replaced; a plugin re-publishing an unchanged ATIS keeps it alive.
  NETWORK_ATIS_RETAIN_MINUTES: z.coerce.number().positive().default(90),
  // Requests one address may make in a ten second window before it is answered 429 (see app.ts).
  // A connected plugin makes two or three a second at its busiest, and a map viewer about the
  // same, so the default allows roughly ten of either behind one address.
  RATE_LIMIT_PER_10S: z.coerce.number().int().positive().default(300),
  // Open /events streams the process will hold at once, across every address (see events.ts).
  MAX_EVENT_SUBSCRIBERS: z.coerce.number().int().positive().default(500),
  // When set, GET /client-logs requires it (Authorization: Bearer, or ?token=). Unset leaves the
  // endpoint public, and it returns every controller's CID, callsign and decision log for the last
  // day. At least 16 characters.
  CLIENT_LOGS_TOKEN: z.string().trim().min(16).optional(),
  // When set, PUT /api/v1/vatsim/atis/:icao requires it (Authorization: Bearer, or ?token=), and
  // the ATIS plugin must be given the same value. Unset leaves publishing an ATIS open to anyone
  // who can reach this API. At least 16 characters.
  ATIS_TOKEN: z.string().trim().min(16).optional(),
  // The GitHub repository (owner/name) whose releases GET /plugin/release offers to the plugin's
  // updater. The plugin only downloads from its own repository, so pointing this elsewhere stops
  // updates being offered rather than redirecting them.
  PLUGIN_RELEASE_REPO: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/).default("JoshuaMicallefYBSU/OzServer-Plugin"),
  // When set, no release newer than this version is offered - for holding a release back while a
  // problem with it is looked into. It cannot downgrade anyone: the plugin only installs a version
  // higher than the one it is running. An empty value counts as unset.
  PLUGIN_RELEASE_MAX_VERSION: z.preprocess(value => value === "" ? undefined : value,
    z.string().trim().regex(/^v?\d+\.\d+(\.\d+){0,2}$/i).optional()),
  // When set, errors are relayed to this Discord webhook (see alerts.ts). The URL is a credential:
  // anyone holding it can post to the channel. An empty value counts as unset.
  DISCORD_WEBHOOK_URL: z.preprocess(value => value === "" ? undefined : value,
    z.string().trim().regex(DISCORD_WEBHOOK_PATTERN, "must be a Discord webhook URL").optional()),
  // Plugin log categories relayed to Discord, comma-separated. "Error" is what the plugin files
  // everything it shows in the vatSys Errors window under.
  DISCORD_LOG_CATEGORIES: z.string().default("Error")
    .transform(value => value.split(",").map(category => category.trim()).filter(Boolean)),
  // When set, live network stats are kept up to date in this webhook's channel (live-stats.ts): a
  // handful of embeds, edited in place. A credential, like DISCORD_WEBHOOK_URL.
  DISCORD_LIVE_WEBHOOK_URL: z.preprocess(value => value === "" ? undefined : value,
    z.string().trim().regex(DISCORD_WEBHOOK_PATTERN, "must be a Discord webhook URL").optional()),
  // Messages already in the channel for embeds this database has no record of, as
  // "key=messageId,key=messageId" - adopted on the first run instead of posting new ones.
  DISCORD_LIVE_MESSAGE_IDS: z.string().default("")
    .transform(value => new Map(value.split(",").map(pair => pair.trim().split("="))
      .filter((pair): pair is [string, string] => pair.length === 2 && /^\d+$/.test(pair[1] ?? ""))
      .map(([key, id]) => [key.trim(), id] as const))),
  LIVE_STATS_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(60)
});

export const config = schema.parse(process.env);
