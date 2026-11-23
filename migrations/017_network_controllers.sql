-- Controllers connected to the network who are not running the OzServer plugin (ML-TBD_CTR on a
-- client without it, say). They never claim anything here, so without this OzServer would offer
-- their airspace to anyone. See external-control.ts for how their sectors are worked out and what
-- holding them means.
--
-- Every plugin reports the controllers its vatSys can see (POST /network/controllers), and the
-- sectors each one is working out of vatSys's own position data and their frequencies. Plugin
-- users are reported too and filtered out on read, against plugin_clients. A row counts only while
-- it is fresh: a controller who logs off stops being reported and ages out.
CREATE TABLE IF NOT EXISTS network_controllers (
  server text NOT NULL,
  callsign text NOT NULL,
  real_name text,
  -- MHz, as text with three decimals ("134.200"): what the controller transmits and receives on.
  frequencies jsonb NOT NULL DEFAULT '[]',
  -- Sector names, as the reporting plugin resolved them.
  sectors jsonb NOT NULL DEFAULT '[]',
  -- Their controller information lines, as vatSys shows them ("Extending MUN, GUN"), read for
  -- what else they cover (external-control.ts atisSectors).
  atis jsonb NOT NULL DEFAULT '[]',
  reported_by_cid integer NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server, callsign)
);
CREATE INDEX IF NOT EXISTS network_controllers_seen ON network_controllers (server, last_seen_at);
