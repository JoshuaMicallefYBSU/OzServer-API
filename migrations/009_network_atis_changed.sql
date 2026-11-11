-- The sections this ATIS letter changed since the previous one, parsed from the leading + markers
-- vatSys writes into the broadcast text ("+[RWY] 34") by network-atis.ts's atisChanges at sync
-- time, in ATIS-editor order. Empty for a ZULU ATIS (free text, no sections) and for a letter that
-- changed nothing.
--
-- Unlike content, an empty array here is a legitimate value rather than a "not parsed yet" marker,
-- so the sync compares this column too - that is what makes existing rows pick up their real value
-- on the first sync after this migration instead of keeping the default.
ALTER TABLE network_atis ADD COLUMN IF NOT EXISTS changed text[] NOT NULL DEFAULT '{}';

-- A letterless ATIS is no longer mirrored: an entry the datafeed lists without an atis_code is a
-- station that has connected but not published a broadcast, and a row of nulls for it was
-- indistinguishable from a real ATIS to anything reading the API. Any such row left over from
-- before is dropped, and the column is made NOT NULL so a regression fails here rather than
-- quietly serving nulls again. Nothing is lost: every row is re-created by the next sync from the
-- live datafeed.
DELETE FROM network_atis WHERE atis_code IS NULL;
ALTER TABLE network_atis ALTER COLUMN atis_code SET NOT NULL;
