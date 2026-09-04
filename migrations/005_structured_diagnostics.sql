-- Structured diagnostics for cross-client sector/FDR investigations.
--
-- Existing clients keep sending category/message/at only. Newer clients add version/session/sequence
-- and a context object; the API also writes its own sector/FDR decision rows into this same
-- timeline so one query can show both client-side vatSys state and server-side ownership decisions.
ALTER TABLE client_logs ADD COLUMN IF NOT EXISTS plugin_version text;
ALTER TABLE client_logs ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE client_logs ADD COLUMN IF NOT EXISTS sequence bigint;
ALTER TABLE client_logs ADD COLUMN IF NOT EXISTS context jsonb;

CREATE INDEX IF NOT EXISTS client_logs_session_idx ON client_logs (session_id, sequence);
CREATE INDEX IF NOT EXISTS client_logs_context_gin_idx ON client_logs USING gin (context);
