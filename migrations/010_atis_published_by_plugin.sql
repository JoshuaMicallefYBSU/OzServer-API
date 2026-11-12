-- One row per airport: the ATIS a vatSys ATIS plugin has published to this server with
-- PUT /api/v1/vatsim/atis/:icao (routes/atis.ts), served back at GET /api/v1/vatsim/atis.
--
-- This table used to be a mirror of VATSIM's public datafeed, re-synced every 30 seconds, with the
-- sections parsed back out of the flat text lines the feed carries (007, 008, 009, all folded in
-- here). The plugin running the ATIS now sends it directly, in the shape vatSys already holds it
-- in, so none of that applies any more: the sections, the letter, the issue time and the list of
-- what changed are all given rather than inferred, and they arrive when the controller publishes
-- rather than up to 30 seconds later.
--
-- Dropped and recreated rather than altered: every column's meaning changed with its source, and
-- no row is worth migrating - each one is re-published in full by its own plugin, and an ATIS this
-- server no longer has is simply an ATIS nobody has published yet.
--
-- Keyed by icao, not callsign, because the publishing route is PUT /vatsim/atis/:icao - the URL
-- names an airport, so an airport has one record. (The datafeed mirror was keyed by callsign to
-- let YSSY_ATIS and YSSY_D_ATIS coexist; if a departure ATIS ever needs its own row again, that is
-- a new key here and a longer URL there, not a change of meaning.)
DROP TABLE IF EXISTS network_atis;

CREATE TABLE network_atis (
    icao varchar(4) PRIMARY KEY,
    -- The ATIS station this came from (YSSY_ATIS), kept as published: it names the broadcast in a
    -- way the airport code alone does not.
    callsign varchar(32) NOT NULL,
    -- Never null. A broadcast with no letter is not a broadcast, and a row of nulls for one was
    -- indistinguishable from a real ATIS to anything reading the API.
    atis_letter varchar(1) NOT NULL,
    -- 'atis' (sectioned) or 'zulu' (the free text a closed tower leaves running). Validated at the
    -- application layer rather than by a CHECK here, like `server` in 006 - a new type should be a
    -- one-line change in network-atis.ts, not a migration.
    type varchar(8) NOT NULL,
    -- "126.250", as it is spoken and displayed. Text, not a number: it is only ever shown.
    frequency varchar(7),
    -- When the controller issued this letter, not when it reached us - re-publishing an unchanged
    -- ATIS must not make it look newer than it is.
    issued timestamptz NOT NULL,
    -- The sections as an object for an 'atis', or a jsonb string (the broadcast text) for a 'zulu'.
    content jsonb NOT NULL,
    -- The sections this letter changed, in ATIS-editor order - what vatSys marks with a leading +.
    -- Empty for a zulu ATIS, and for a letter that changed nothing.
    changed text[] NOT NULL DEFAULT '{}',
    -- Who published it. Stored, never served (routes/atis.ts answers a GET with the broadcast
    -- alone): it is what makes a bad or stale record traceable to the client that sent it, which
    -- is an operator's question, not a public one.
    controller_callsign varchar(32) NOT NULL,
    controller_cid integer NOT NULL,
    -- Which plugin build published this. Telemetry only: useful when one version starts sending
    -- something odd, never read to decide anything.
    client_name text,
    client_version text,
    received_at timestamptz NOT NULL DEFAULT now()
);
