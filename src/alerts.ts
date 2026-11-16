// What this API reports to Discord (see discord.ts): its own server errors, and the plugin log
// lines whose category is listed in DISCORD_LOG_CATEGORIES. A no-op unless DISCORD_WEBHOOK_URL is set.
import { config } from "./config.js";
import { createDiscordNotifier } from "./discord.js";
import type { ControllerIdentity } from "./types.js";

export const discord = createDiscordNotifier(config.DISCORD_WEBHOOK_URL);

const categories = new Set(config.DISCORD_LOG_CATEGORIES.map(category => category.toLowerCase()));

type ClientLogLine = {
  category: string;
  message: string;
  plugin_version?: string;
  context?: Record<string, unknown>;
};

// One forwarded plugin log line, if its category is one being relayed.
export function reportClientLog(identity: ControllerIdentity, line: ClientLogLine): void {
  if (!discord.enabled || !categories.has(line.category.toLowerCase())) return;
  const version = line.plugin_version ? `, plugin ${line.plugin_version}` : "";
  const cause = typeof line.context?.cause === "string" ? `\n\n${line.context.cause}` : "";
  discord.notify({
    title: `Plugin ${line.category.toLowerCase()} - ${identity.callsign} (${identity.cid}) on ${identity.server}${version}`,
    detail: `${line.message}${cause}`
  });
}

// A fault of this server's own: an unhandled error in a route, or in the maintenance sweep.
export function reportServerError(where: string, error: unknown): void {
  if (!discord.enabled) return;
  const detail = error instanceof Error
    ? (error.stack ?? error.message).split("\n").slice(0, 8).join("\n")
    : String(error);
  discord.notify({ title: `API error - ${where}`, detail });
}
