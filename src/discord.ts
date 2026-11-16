// Relays errors to a Discord channel through a webhook, so a problem is seen when it happens
// rather than when someone goes looking in client_logs.
//
// Entries are queued and sent as one message every few seconds. That keeps a burst (a reconnect,
// a backend fault every client reports at once) well inside Discord's webhook rate limit, and
// means a caller never waits on Discord: notify() only ever adds to a queue.
//
// The webhook URL is a credential - anyone holding it can post to the channel - so it comes from
// the environment and is never logged. Free of config imports so it can be unit tested.

// Discord refuses a message over 2000 characters.
const MAX_MESSAGE_LENGTH = 1_900;
const MAX_ENTRY_LENGTH = 900;
const FLUSH_MS = 5_000;
// Entries held while Discord is slow or rate limiting. Beyond this the newest are counted, not kept.
const MAX_QUEUED = 40;
// An identical entry inside this window is counted against the first rather than sent again.
const REPEAT_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export const DISCORD_WEBHOOK_PATTERN = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export type DiscordEntry = {
  // Shown in bold above the detail: what failed and for whom.
  title: string;
  // Shown in a code block. Optional.
  detail?: string | null;
};

type Fetch = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
}) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

type Queued = { key: string; entry: DiscordEntry; count: number };

// Keeps log text from breaking out of its code block or formatting the title.
const plain = (text: string) => text.replace(/```/g, "'''").replace(/\r/g, "");
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 3)}...` : text;

export function formatEntry(entry: DiscordEntry, count = 1): string {
  const title = clip(plain(entry.title).replace(/\n+/g, " "), 300);
  const repeats = count > 1 ? ` (x${count})` : "";
  const detail = entry.detail?.trim();
  if (!detail) return `**${title}**${repeats}`;
  return `**${title}**${repeats}\n\`\`\`\n${clip(plain(detail), MAX_ENTRY_LENGTH)}\n\`\`\``;
}

export function createDiscordNotifier(
  webhookUrl: string | null | undefined,
  options: { fetcher?: Fetch; flushMs?: number; now?: () => number } = {}
) {
  const fetcher = options.fetcher ?? (fetch as unknown as Fetch);
  const now = options.now ?? Date.now;
  const queue: Queued[] = [];
  const recent = new Map<string, { at: number; queued: Queued | null }>();
  let dropped = 0;
  let pausedUntil = 0;
  let sending = false;
  let timer: NodeJS.Timeout | null = null;

  async function flush(): Promise<void> {
    for (const [key, seen] of recent) {
      if (seen.queued === null && now() - seen.at > REPEAT_WINDOW_MS) recent.delete(key);
    }
    if (!webhookUrl || sending || now() < pausedUntil) return;
    if (queue.length === 0 && dropped === 0) return;
    sending = true;
    try {
      // As many whole entries as fit in one message; the rest wait for the next flush.
      const parts: string[] = [];
      let length = 0;
      let taken = 0;
      for (const item of queue) {
        const text = formatEntry(item.entry, item.count);
        if (parts.length > 0 && length + text.length + 1 > MAX_MESSAGE_LENGTH) break;
        parts.push(text);
        length += text.length + 1;
        taken++;
      }
      const sent = queue.slice(0, taken);
      // The count of entries that never fitted in the queue goes out with the last of it.
      const reported = taken === queue.length ? dropped : 0;
      if (reported > 0) parts.push(`*...and ${reported} more not shown.*`);

      const response = await fetcher(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "OzServer",
          content: clip(parts.join("\n"), 2_000),
          // Log text is never allowed to ping anyone.
          allowed_mentions: { parse: [] }
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (response.status === 429) {
        // Discord says how long to wait, in seconds. The entries stay queued.
        const body = await response.json().catch(() => null) as { retry_after?: number } | null;
        pausedUntil = now() + Math.min(Math.max((body?.retry_after ?? 5) * 1000, 1_000), 60_000);
        return;
      }
      // Any other answer is final for these entries: retrying a message Discord has refused would
      // only hold up the ones behind it.
      queue.splice(0, taken);
      dropped -= reported;
      for (const item of sent) {
        const seen = recent.get(item.key);
        if (seen?.queued === item) seen.queued = null;
      }
    } catch {
      // Discord unreachable. Left queued, bounded by MAX_QUEUED, and tried again next flush.
    } finally {
      sending = false;
    }
  }

  return {
    enabled: Boolean(webhookUrl),

    // Never throws and never waits: safe to call from a request handler or an error handler.
    notify(entry: DiscordEntry): void {
      if (!webhookUrl) return;
      const key = `${entry.title}\n${entry.detail ?? ""}`;
      const seen = recent.get(key);
      if (seen && now() - seen.at < REPEAT_WINDOW_MS) {
        // Still waiting to be sent: count it there. Already sent: suppressed until the window ends.
        if (seen.queued) seen.queued.count++;
        return;
      }
      if (queue.length >= MAX_QUEUED) {
        dropped++;
        return;
      }
      const queued: Queued = { key, entry, count: 1 };
      queue.push(queued);
      recent.set(key, { at: now(), queued });
    },

    start(): void {
      if (!webhookUrl || timer) return;
      timer = setInterval(() => void flush(), options.flushMs ?? FLUSH_MS);
      timer.unref();
    },

    // Sends what is queued and stops the timer. Used on shutdown.
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      await flush();
    },

    flush
  };
}

export type DiscordNotifier = ReturnType<typeof createDiscordNotifier>;
