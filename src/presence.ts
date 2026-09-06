// When this process started. Every check that ages a row against last_seen_online_at needs this,
// because that column can only ever be refreshed by a request actually reaching this process (the
// heartbeat hook in app.ts, and the claim/accept/resume/request-accept handlers it backs up) - so
// right after this process itself starts, every genuinely-still-connected controller's row looks
// exactly as stale as this process's own downtime was long, through no fault of theirs. The
// VATSIM-datafeed check this replaced was, whatever its other problems, independent of our own
// uptime: it would have re-confirmed anyone genuinely still connected the moment it ran again,
// regardless of how long we had been down. A pure heartbeat has no such independent fallback, so it
// needs this instead.
const startedAt = Date.now();

// True until this process has been up for one full `windowMs`. Every place that would otherwise
// treat a stale-looking last_seen_online_at as "gone" - runMaintenance's disconnect sweep, and
// claimGroup's presence check - has to also ask this first, passing its OWN threshold, and treat
// "we can't tell yet" the same as "still there": the alternative is a mass sector release, or a
// claim taking someone's sector out from under them, triggered by an outage of *this server's*, not
// a disconnect of theirs.
//
// The window has to match whatever threshold the caller is about to apply, not one fixed value for
// everyone: passing DISCONNECT_GRACE_MINUTES here unconditionally - as this once did - meant
// claimGroup's own, much shorter PRESENCE_TIMEOUT_SECONDS was overridden by this for the full five
// minutes after every single restart, silently reverting fast claim-takeover to the old
// wait-out-the-full-grace behaviour it was built to replace, on every deploy. A live test against a
// freshly-restarted instance is exactly what caught this - it looked correct by inspection alone.
//
// A normal deploy's downtime is seconds (the VPS's own rollout is health-check gated), so this
// costs nothing in the ordinary case either way; a row that was genuinely stale before the outage
// still gets exactly its caller's usual window, just measured from whenever this process actually
// came back up able to observe it, rather than from whenever its owner actually left.
export function isWithinStartupGrace(windowMs: number): boolean {
  return Date.now() - startedAt < windowMs;
}
