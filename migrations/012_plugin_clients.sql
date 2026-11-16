-- Every controller whose plugin is calling this API, sectors or not. sector_ownerships only knows
-- controllers who hold something, so a plugin user holding nothing could not be told apart from a
-- controller without the plugin - whose tags no plugin client reports, and which the plugin has to
-- cover for them (FdrSync.TrackedOutsideOzServer). Refreshed on every authenticated call.
CREATE TABLE IF NOT EXISTS plugin_clients (
  controller_cid integer NOT NULL,
  controller_callsign text NOT NULL,
  server text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server, controller_callsign, controller_cid)
);
CREATE INDEX IF NOT EXISTS plugin_clients_seen ON plugin_clients (server, last_seen_at);
