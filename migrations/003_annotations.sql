-- Notes and freehand drawings placed on the radar picture by one controller and seen by all of them
-- (issue #9). Both are the same thing to the server - a shape in lat/lon with an author - so they
-- share a table rather than splitting into two that would need the same lifecycle, the same
-- ownership rules and the same expiry written twice.
--
-- kind is what the plugin renders it as: a note is vatSys's own ASD text area, a stroke is a line
-- drawn on the map. That distinction stays out of the columns because everything else about them is
-- identical, and a CHECK is cheaper to extend than a second table when the next shape arrives.
CREATE TABLE IF NOT EXISTS annotations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            text NOT NULL CHECK (kind IN ('note', 'stroke')),
    author_cid      integer NOT NULL,
    author_callsign text NOT NULL,

    -- Notes only. A stroke has no text and a note is meaningless without it, which is what the
    -- CHECK below enforces rather than leaving it to the route.
    body            text,

    -- [{"lat":-23.7,"lon":133.9}, ...] - one point for a note, the whole path for a stroke.
    -- Stored in lat/lon rather than screen space on purpose: every controller is looking at a
    -- different zoom, centre and screen size, so a pixel path drawn on one scope means nothing on
    -- another. Ordinary jsonb rather than PostGIS - nothing here is queried by geometry, it is
    -- fetched whole and drawn, and the plugin already speaks in Coordinates.
    points          jsonb NOT NULL,

    -- Free-form so the plugin owns its own palette, the way it owns its map colours.
    colour          text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- Follows sector_ownerships: refreshed while the author is seen online, and the maintenance
    -- sweep removes anything whose author has been gone longer than the disconnect grace. An
    -- annotation is a live working note, and a stale one on an ATC display is worse than none -
    -- but a controller who drops for thirty seconds should not lose their work either, which is
    -- exactly the trade-off that grace window already encodes for sectors.
    last_seen_online_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT annotations_body_matches_kind CHECK (
        (kind = 'note' AND body IS NOT NULL) OR (kind = 'stroke' AND body IS NULL)
    )
);

-- The sweep deletes by author, and the plugin fetches every current annotation on connect and on
-- each change signal; nothing looks one up by anything else.
CREATE INDEX IF NOT EXISTS annotations_author_idx ON annotations (author_cid, author_callsign);
