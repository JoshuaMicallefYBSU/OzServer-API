CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sectors (
    id bigserial PRIMARY KEY,
    name varchar(32) NOT NULL UNIQUE,
    full_name text NOT NULL DEFAULT '',
    callsign varchar(32),
    frequency varchar(16),
    type varchar(8),
    responsible_sectors jsonb NOT NULL DEFAULT '[]',
    boundary jsonb NOT NULL DEFAULT '[]',
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sectors_callsign_idx ON sectors (callsign);
CREATE INDEX IF NOT EXISTS sectors_type_idx ON sectors (type);

CREATE TABLE IF NOT EXISTS positions (
    id bigserial PRIMARY KEY,
    name varchar(64) NOT NULL UNIQUE,
    asmgcs_airport varchar(4),
    default_lat double precision NOT NULL,
    default_lon double precision NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sector_ownerships (
    sector_id bigint PRIMARY KEY REFERENCES sectors(id) ON DELETE CASCADE,
    controller_cid integer NOT NULL,
    controller_callsign varchar(32) NOT NULL,
    last_seen_online_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sector_ownerships_controller_idx ON sector_ownerships (controller_cid, controller_callsign);

CREATE TABLE IF NOT EXISTS sector_requests (
    id bigserial PRIMARY KEY,
    sector_id bigint NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
    requesting_cid integer NOT NULL,
    requesting_callsign varchar(32) NOT NULL,
    target_cid integer NOT NULL,
    target_callsign varchar(32) NOT NULL,
    rejected_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (sector_id, requesting_cid)
);

CREATE TABLE IF NOT EXISTS resume_snapshots (
    controller_cid integer NOT NULL,
    controller_callsign varchar(32) NOT NULL,
    sectors jsonb NOT NULL DEFAULT '[]',
    flights jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (controller_cid, controller_callsign)
);

CREATE TABLE IF NOT EXISTS flight_data_records (
    callsign varchar(20) PRIMARY KEY,
    controlling_cid integer,
    controlling_callsign varchar(32),
    current_sector varchar(32),
    data jsonb NOT NULL DEFAULT '{}',
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flight_data_records_last_seen_idx ON flight_data_records (last_seen_at);

CREATE TABLE IF NOT EXISTS atis_broadcasts (
    icao varchar(4) PRIMARY KEY,
    atis_letter varchar(1) NOT NULL,
    content jsonb NOT NULL,
    frequency integer,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
