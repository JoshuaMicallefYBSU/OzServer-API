-- The Arrival List ("A:YSSY List"). The plugin replaces vatSys's own window with one served from
-- here - see routes/arrivals.ts.
--
-- Which flights are on an airport's list is not stored: it is every departed flight record inbound
-- to it. Only the order controllers have put them in is. A row whose flight has left the list is
-- ignored on read and removed by the next reorder at that airport.
CREATE TABLE IF NOT EXISTS arrival_sequences (
  server text NOT NULL,
  ades text NOT NULL,
  callsign text NOT NULL,
  -- 0 is the bottom of the sequence. Contiguous per airport after every reorder.
  seq_index integer NOT NULL,
  updated_by_cid integer NOT NULL,
  updated_by_callsign text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server, ades, callsign)
);

-- Which controllers have an airport's Arrival List open, for the count in its title bar. Each
-- plugin reports its open lists every few seconds (POST /arrivals/viewing), so a row counts only
-- while it is fresh; maintenance.ts removes the stale ones.
CREATE TABLE IF NOT EXISTS arrival_list_viewers (
  server text NOT NULL,
  ades text NOT NULL,
  controller_cid integer NOT NULL,
  controller_callsign text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server, ades, controller_callsign, controller_cid)
);
CREATE INDEX IF NOT EXISTS arrival_list_viewers_seen ON arrival_list_viewers (server, ades, last_seen_at);
