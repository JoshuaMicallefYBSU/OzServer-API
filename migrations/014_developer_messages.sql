-- Messages sent from the website's /console to controllers' plugins, and their answers
-- (routes/messages.ts). A notice from the people running OzServer: a known problem, a release to
-- install, a question about something seen in the logs.

CREATE TABLE IF NOT EXISTS developer_messages (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  -- Null: every server.
  server text,
  -- Null: everyone on the server(s), including anyone who connects before it expires. Otherwise
  -- the callsigns it was sent to (upper-case), and nobody else.
  target_callsigns text[],
  allow_reply boolean NOT NULL DEFAULT false,
  -- Who sent it, as typed into the console - shown to the controller.
  sent_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Not delivered to anyone who has not already had it once this has passed.
  expires_at timestamptz NOT NULL,
  withdrawn_at timestamptz
);
CREATE INDEX IF NOT EXISTS developer_messages_expires ON developer_messages (expires_at);

-- One row per controller a message reached: delivered when their plugin fetched it, read when they
-- dismissed or answered it.
CREATE TABLE IF NOT EXISTS developer_message_receipts (
  message_id bigint NOT NULL REFERENCES developer_messages(id) ON DELETE CASCADE,
  controller_cid integer NOT NULL,
  controller_callsign text NOT NULL,
  server text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  PRIMARY KEY (message_id, server, controller_callsign, controller_cid)
);

CREATE TABLE IF NOT EXISTS developer_message_replies (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES developer_messages(id) ON DELETE CASCADE,
  controller_cid integer NOT NULL,
  controller_callsign text NOT NULL,
  server text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS developer_message_replies_message ON developer_message_replies (message_id, created_at);
