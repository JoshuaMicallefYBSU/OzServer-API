-- Every controller's plugin log, in one place.
--
-- Diagnosing anything involving two controllers previously meant collecting a text file from each
-- of them and lining the timestamps up by hand - and half the time the interesting client was the
-- one whose log nobody had. A sector handoff, a tag that flashed instead of landing, a position
-- relinquished to the wrong person: all of them are two clients disagreeing, and neither log alone
-- shows it.
--
-- Deliberately not everything the plugin writes. The client forwards only the lines that record a
-- decision - what it concluded and why - not its own HTTP chatter, which this server already logs
-- for itself and which would be the overwhelming majority of the volume.
CREATE TABLE IF NOT EXISTS client_logs (
    id              bigserial PRIMARY KEY,

    controller_cid      integer NOT NULL,
    controller_callsign text NOT NULL,

    -- The plugin's own ActionLog category: Primary, Tag, Ownership, Ghost, Overlay, ...
    category        text NOT NULL,
    message         text NOT NULL,

    -- When the client logged it, which is what matters for ordering two clients against each other.
    -- Distinct from created_at: these arrive in batches, so several seconds of a session can land at
    -- one instant, and a slow or retrying client can deliver minutes late.
    logged_at       timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- The two ways these are ever read: everything around a moment across all controllers, or one
-- controller's own thread through it.
CREATE INDEX IF NOT EXISTS client_logs_logged_at_idx ON client_logs (logged_at DESC);
CREATE INDEX IF NOT EXISTS client_logs_controller_idx ON client_logs (controller_callsign, logged_at DESC);
