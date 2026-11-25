import { beforeEach, describe, expect, it, vi } from "vitest";

// presence.ts keeps its clocks at module level, so each test loads its own copy at a known time.
const T0 = Date.UTC(2026, 10, 25, 0, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const SWEEP_GRACE = 2 * MINUTE;

async function load() {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  return import("./presence.js");
}

describe("presence grace", () => {
  beforeEach(() => vi.useRealTimers());

  it("covers the window after a start, and no longer", async () => {
    const presence = await load();
    expect(presence.isWithinStartupGrace(SWEEP_GRACE, T0 + MINUTE)).toBe(true);
    expect(presence.isWithinStartupGrace(SWEEP_GRACE, T0 + 3 * MINUTE)).toBe(false);
  });

  it("ignores the gaps between ordinary calls", async () => {
    const presence = await load();
    for (let at = T0 + 3 * MINUTE; at < T0 + 4 * MINUTE; at += 3 * SECOND) presence.notePluginRequest(at);
    expect(presence.isWithinStartupGrace(SWEEP_GRACE, T0 + 4 * MINUTE)).toBe(false);
  });

  it("holds the sweep off while no plugin can get through, and for a full window once they can", async () => {
    const presence = await load();
    presence.notePluginRequest(T0 + 10 * MINUTE);
    // Three minutes of silence from everyone: past the sweep's grace, and nobody has left.
    expect(presence.isWithinStartupGrace(SWEEP_GRACE, T0 + 13 * MINUTE)).toBe(true);
    presence.notePluginRequest(T0 + 13 * MINUTE);
    expect(presence.isWithinStartupGrace(SWEEP_GRACE, T0 + 14 * MINUTE)).toBe(true);
    for (let at = T0 + 13 * MINUTE; at <= T0 + 16 * MINUTE; at += 3 * SECOND) presence.notePluginRequest(at);
    expect(presence.isWithinStartupGrace(SWEEP_GRACE, T0 + 16 * MINUTE)).toBe(false);
  });

  it("stops holding it off once the network has simply emptied", async () => {
    const presence = await load();
    presence.notePluginRequest(T0 + 10 * MINUTE);
    expect(presence.isWithinStartupGrace(SWEEP_GRACE, T0 + 30 * MINUTE)).toBe(false);
    // The next controller to log on, hours later, does not start a grace either.
    presence.notePluginRequest(T0 + 300 * MINUTE);
    expect(presence.isWithinStartupGrace(SWEEP_GRACE, T0 + 300 * MINUTE + SECOND)).toBe(false);
  });
});
