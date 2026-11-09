-- The ATIS broken into its vatSys sections (APCH, RWY, WIND, ...), parsed from text_atis by
-- network-atis.ts's atisContent at sync time - the same field -> value shape as
-- atis_broadcasts.content. Existing rows pick theirs up on the next sync (the sync compares
-- content too, so an empty '{}' here counts as a change).
-- For a ZULU ATIS (free text, no sections) content is instead a jsonb string: the raw broadcast text.
ALTER TABLE network_atis ADD COLUMN IF NOT EXISTS content jsonb NOT NULL DEFAULT '{}';
