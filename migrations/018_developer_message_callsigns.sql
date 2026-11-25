-- A message goes to chosen callsigns, not one (routes/messages.ts). 014 was edited to say so after
-- it had been applied, so it never ran again: production had the column added by hand, and a
-- database built from these files had only the old target_callsign, on which every message route
-- failed. IF NOT EXISTS makes this a no-op where the column is already there.

ALTER TABLE developer_messages ADD COLUMN IF NOT EXISTS target_callsigns text[];

-- A message addressed under the old column stays addressed to that controller rather than
-- becoming a broadcast. The old column is left in place, unused. A database whose 014 ran while
-- it briefly declared target_callsigns never had the old column, and has nothing to carry over.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'developer_messages' AND column_name = 'target_callsign'
  ) THEN
    UPDATE developer_messages
       SET target_callsigns = ARRAY[upper(target_callsign)]
     WHERE target_callsign IS NOT NULL AND target_callsigns IS NULL;
  END IF;
END $$;
