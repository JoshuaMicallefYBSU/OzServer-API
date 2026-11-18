-- The Discord messages the live network stats are edited into (live-stats.ts), one per embed. Kept
-- so a restart or deploy edits the same messages rather than posting a new set to the channel.
CREATE TABLE IF NOT EXISTS discord_live_messages (
  key text PRIMARY KEY,
  message_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
