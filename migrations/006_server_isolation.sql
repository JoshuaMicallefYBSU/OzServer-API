-- Multi-environment isolation: the same sector names and pilot callsigns can exist independently
-- and simultaneously across 4 fully isolated vatSys connection targets - live VATSIM, SweatBox-1,
-- SweatBox-2, and LocalHost (slugs: live/sb1/sb2/newsb - see NetworkServer.cs in the plugin).
-- `server` is free text, validated only at the application layer against a small allowlist
-- (auth.ts SERVERS) - deliberately not a CHECK constraint, so a 5th environment is a one-line
-- change there, not a migration.
--
-- sectors and positions are untouched: both are static airspace/reference geometry from the
-- vatSys dataset sync (sync-dataset.ts), identical regardless of which server a controller is
-- on, so they stay global/shared. Every other table below carries live, per-controller state and
-- needs a row per environment - existing rows default to 'live' since that is what every one of
-- them actually was before this column existed.

ALTER TABLE sector_ownerships    ADD COLUMN IF NOT EXISTS server text NOT NULL DEFAULT 'live';
ALTER TABLE sector_requests      ADD COLUMN IF NOT EXISTS server text NOT NULL DEFAULT 'live';
ALTER TABLE flight_data_records  ADD COLUMN IF NOT EXISTS server text NOT NULL DEFAULT 'live';
ALTER TABLE resume_snapshots     ADD COLUMN IF NOT EXISTS server text NOT NULL DEFAULT 'live';
ALTER TABLE annotations          ADD COLUMN IF NOT EXISTS server text NOT NULL DEFAULT 'live';
ALTER TABLE atis_broadcasts      ADD COLUMN IF NOT EXISTS server text NOT NULL DEFAULT 'live';
ALTER TABLE client_logs          ADD COLUMN IF NOT EXISTS server text NOT NULL DEFAULT 'live';

-- sector_ownerships: a bare sector_id PK is exactly what let the same sector collide across
-- servers. The composite PK also becomes the ON CONFLICT target every claim/resume/transfer
-- upsert needs.
ALTER TABLE sector_ownerships DROP CONSTRAINT sector_ownerships_pkey;
ALTER TABLE sector_ownerships ADD PRIMARY KEY (sector_id, server);

-- sector_requests: one pending request per (sector, requester, server) - the same controller may
-- legitimately have independent pending requests for the same sector name on two different
-- servers.
ALTER TABLE sector_requests DROP CONSTRAINT sector_requests_sector_id_requesting_cid_key;
ALTER TABLE sector_requests ADD CONSTRAINT sector_requests_sector_requester_server_key
    UNIQUE (sector_id, requesting_cid, server);

-- flight_data_records: bare callsign PK was the most urgent collision risk - the same pilot
-- callsign can genuinely be flying simultaneously in `live` and a sweatbox session.
ALTER TABLE flight_data_records DROP CONSTRAINT flight_data_records_pkey;
ALTER TABLE flight_data_records ADD PRIMARY KEY (callsign, server);

-- resume_snapshots: which sectors/flights a controller was holding on graceful disconnect is
-- itself a per-server fact.
ALTER TABLE resume_snapshots DROP CONSTRAINT resume_snapshots_pkey;
ALTER TABLE resume_snapshots ADD PRIMARY KEY (controller_cid, controller_callsign, server);

-- atis_broadcasts: a training scenario's ATIS letter/content for an airport is independent of
-- that airport's real-world current ATIS.
ALTER TABLE atis_broadcasts DROP CONSTRAINT atis_broadcasts_pkey;
ALTER TABLE atis_broadcasts ADD PRIMARY KEY (icao, server);

-- client_logs and annotations keep their existing surrogate PKs (bigserial id / uuid) unchanged -
-- server is a plain filter column on both, not part of any uniqueness.
CREATE INDEX IF NOT EXISTS annotations_server_idx ON annotations (server);
CREATE INDEX IF NOT EXISTS client_logs_server_idx ON client_logs (server);
CREATE INDEX IF NOT EXISTS flight_data_records_server_idx ON flight_data_records (server);
