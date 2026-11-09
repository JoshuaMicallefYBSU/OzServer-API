-- Every VATPAC airport ATIS currently connected to the live VATSIM network, mirrored from VATSIM's
-- public datafeed by network-atis-sync.ts - independent of whether the controller running it uses
-- this plugin at all.
--
-- Deliberately a separate table from atis_broadcasts rather than more rows in it: that table holds
-- what an OzServer controller's own vatSys pushed (field-structured content - WIND, VIS, QNH, ... -
-- that the next controller on the station picks back up), while the datafeed only carries the
-- broadcast's flat text lines. Writing one into the other would clobber the structured handover
-- content with something vatSys cannot load back. No `server` column either: the datafeed only
-- ever describes the live network.
--
-- Keyed by callsign, not icao: one airport can legitimately run more than one ATIS at once
-- (YSSY_ATIS alongside a YSSY_D_ATIS departure ATIS). A row exists only while its station is
-- connected - every sync deletes the ones the feed no longer lists.
CREATE TABLE IF NOT EXISTS network_atis (
    callsign varchar(32) PRIMARY KEY,
    icao varchar(4) NOT NULL,
    atis_code varchar(1),
    frequency varchar(7) NOT NULL,
    text_atis text[] NOT NULL DEFAULT '{}',
    cid integer NOT NULL,
    name text,
    logon_time timestamptz,
    last_updated timestamptz,
    synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS network_atis_icao_idx ON network_atis (icao);
