// Startup grace for presence checks. last_seen_online_at is refreshed only by requests reaching
// this process (the heartbeat in app.ts), so just after a restart every connected controller's row
// looks as stale as the downtime was long.
const startedAt = Date.now();

// True until this process has been up for `windowMs`. Every check that treats a stale
// last_seen_online_at as "gone" - the disconnect sweep, claimGroup's presence check - asks this
// first and treats "cannot tell yet" as "still there"; otherwise an outage of this server would
// release sectors in bulk or let a claim take a connected controller's sector.
//
// Pass the threshold the caller is about to apply. A longer window than the caller's own (the
// sweep's grace for a presence check) would suspend that check for minutes after every restart.
export function isWithinStartupGrace(windowMs: number): boolean {
  return Date.now() - startedAt < windowMs;
}
