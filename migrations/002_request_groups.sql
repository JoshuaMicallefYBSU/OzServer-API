-- Sectors requested together in one Apply are one decision, not several. Without a group the three
-- rows a single commit writes are indistinguishable from three unrelated requests, so the target
-- controller was notified once per sector.
--
-- The default matters for existing rows: each pre-existing request really was independent, so
-- giving every one its own group preserves exactly the behaviour they had.
ALTER TABLE sector_requests
    ADD COLUMN IF NOT EXISTS group_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS sector_requests_group_idx ON sector_requests (group_id);
