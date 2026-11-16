import { describe, expect, it } from "vitest";
import { createDiscordNotifier, DISCORD_WEBHOOK_PATTERN, formatEntry } from "./discord.js";

const url = "https://discord.com/api/webhooks/123456789012345678/abc-DEF_123";

// A stand-in for Discord that records what it was sent and answers with the given statuses in turn.
function fakeDiscord(statuses: number[] = []) {
  const sent: Array<{ url: string; body: { content: string; allowed_mentions: unknown; username: string } }> = [];
  const fetcher = async (target: string, init: { body: string }) => {
    sent.push({ url: target, body: JSON.parse(init.body) });
    const status = statuses.shift() ?? 204;
    return { status, ok: status < 300, json: async () => ({ retry_after: 2 }) };
  };
  return { sent, fetcher };
}

describe("DISCORD_WEBHOOK_PATTERN", () => {
  it("accepts a Discord webhook URL and nothing else", () => {
    expect(DISCORD_WEBHOOK_PATTERN.test(url)).toBe(true);
    expect(DISCORD_WEBHOOK_PATTERN.test("https://discordapp.com/api/webhooks/1/a")).toBe(true);
    expect(DISCORD_WEBHOOK_PATTERN.test("http://discord.com/api/webhooks/1/a")).toBe(false);
    expect(DISCORD_WEBHOOK_PATTERN.test("https://discord.com.evil.example/api/webhooks/1/a")).toBe(false);
    expect(DISCORD_WEBHOOK_PATTERN.test("https://example.com/api/webhooks/1/a")).toBe(false);
  });
});

describe("formatEntry", () => {
  it("puts the detail in a code block it cannot break out of", () => {
    const text = formatEntry({ title: "Plugin error", detail: "before ``` after" });
    expect(text).toBe("**Plugin error**\n```\nbefore ''' after\n```");
  });

  it("keeps a title on one line and marks repeats", () => {
    expect(formatEntry({ title: "two\nlines" }, 3)).toBe("**two lines** (x3)");
  });

  it("clips a very long detail", () => {
    expect(formatEntry({ title: "t", detail: "x".repeat(5_000) }).length).toBeLessThan(1_000);
  });
});

describe("createDiscordNotifier", () => {
  it("does nothing at all without a webhook", async () => {
    const { sent, fetcher } = fakeDiscord();
    const discord = createDiscordNotifier(undefined, { fetcher });
    discord.notify({ title: "ignored" });
    await discord.flush();
    expect(discord.enabled).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("sends everything queued as one message that cannot ping anyone", async () => {
    const { sent, fetcher } = fakeDiscord();
    const discord = createDiscordNotifier(url, { fetcher });
    discord.notify({ title: "first", detail: "@everyone look" });
    discord.notify({ title: "second" });
    await discord.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(url);
    expect(sent[0]!.body.content).toContain("**first**");
    expect(sent[0]!.body.content).toContain("**second**");
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
    await discord.flush();
    expect(sent).toHaveLength(1);
  });

  it("counts a repeat against the queued entry, and stays quiet about it once sent", async () => {
    const { sent, fetcher } = fakeDiscord();
    let time = 0;
    const discord = createDiscordNotifier(url, { fetcher, now: () => time });
    for (let index = 0; index < 4; index++) discord.notify({ title: "same", detail: "thing" });
    await discord.flush();
    expect(sent[0]!.body.content).toContain("**same** (x4)");

    time = 30_000;
    discord.notify({ title: "same", detail: "thing" });
    await discord.flush();
    expect(sent).toHaveLength(1);

    time = 61_000;
    discord.notify({ title: "same", detail: "thing" });
    await discord.flush();
    expect(sent).toHaveLength(2);
  });

  it("splits a large backlog across messages, each within Discord's limit", async () => {
    const { sent, fetcher } = fakeDiscord();
    const discord = createDiscordNotifier(url, { fetcher });
    for (let index = 0; index < 10; index++) discord.notify({ title: `error ${index}`, detail: "y".repeat(800) });
    for (let pass = 0; pass < 6; pass++) await discord.flush();
    expect(sent.length).toBeGreaterThan(1);
    for (const message of sent) expect(message.body.content.length).toBeLessThanOrEqual(2_000);
    expect(sent.map(message => message.body.content).join("")).toContain("error 9");
  });

  it("reports how many entries did not fit in the queue", async () => {
    const { sent, fetcher } = fakeDiscord();
    const discord = createDiscordNotifier(url, { fetcher });
    for (let index = 0; index < 45; index++) discord.notify({ title: `e${index}` });
    await discord.flush();
    expect(sent[0]!.body.content).toContain("and 5 more not shown");
    await discord.flush();
    expect(sent).toHaveLength(1);
  });

  it("keeps entries queued while rate limited and sends them afterwards", async () => {
    const { sent, fetcher } = fakeDiscord([429]);
    let time = 0;
    const discord = createDiscordNotifier(url, { fetcher, now: () => time });
    discord.notify({ title: "held" });
    await discord.flush();
    await discord.flush();
    expect(sent).toHaveLength(1);
    time = 2_500;
    await discord.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.content).toContain("**held**");
  });

  it("survives Discord being unreachable", async () => {
    let fail = true;
    const sent: string[] = [];
    const discord = createDiscordNotifier(url, {
      fetcher: async (_target, init) => {
        if (fail) throw new Error("offline");
        sent.push(init.body);
        return { status: 204, ok: true, json: async () => null };
      }
    });
    discord.notify({ title: "kept" });
    await discord.flush();
    fail = false;
    await discord.flush();
    expect(sent).toHaveLength(1);
  });
});
