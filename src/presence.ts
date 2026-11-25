// Grace for presence checks. last_seen_online_at is refreshed only by requests reaching this
// process (the heartbeat in app.ts), so just after a restart every connected controller's row
// looks as stale as the downtime was long.
//
// The same is true when the process stayed up and the requests stopped arriving: the proxy in
// front of it down, or the host's network. Nothing restarted, so nothing reset the clock below,
// and once the plugins got through again the sweep had already released every controller's
// sectors - still connected to VATSIM, all of them, with their tags dropped by vatSys as the
// sectors left. With more than one controller online some plugin calls every few seconds, so a
// silence from all of them at once is this server being out of reach, not everyone leaving.
let startedAt = Date.now();
let lastPluginRequestAt = 0;

// No call from any plugin for this long is an outage: each one polls every 3 s.
const UNREACHABLE_AFTER_MS = 20_000;
// And for this long it is no outage at all, only an empty network: whatever the last controller
// left behind is swept as usual rather than kept until the next one happens to log on.
const EMPTY_AFTER_MS = 15 * 60_000;

const outage = (silentMs: number) => silentMs > UNREACHABLE_AFTER_MS && silentMs < EMPTY_AFTER_MS;

// Called for every authenticated plugin request (app.ts). The first one after an outage starts
// the grace again, exactly as a restart would have.
export function notePluginRequest(now = Date.now()): void {
  if (lastPluginRequestAt !== 0 && outage(now - lastPluginRequestAt)) startedAt = now;
  lastPluginRequestAt = now;
}

// True until this process has been up - or back in reach - for `windowMs`, and all through an
// outage. Every check that treats a stale last_seen_online_at as "gone" - the disconnect sweep,
// claimGroup's presence check - asks this first and treats "cannot tell yet" as "still there";
// otherwise an outage of this server would release sectors in bulk or let a claim take a connected
// controller's sector.
//
// Pass the threshold the caller is about to apply. A longer window than the caller's own (the
// sweep's grace for a presence check) would suspend that check for minutes after every restart.
export function isWithinStartupGrace(windowMs: number, now = Date.now()): boolean {
  if (lastPluginRequestAt !== 0 && outage(now - lastPluginRequestAt)) return true;
  return now - startedAt < windowMs;
}
