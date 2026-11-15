-- Shared notes and map drawing have been removed from the plugin and the API, so the table that
-- held them goes too. 003 created it and 006 scoped it per server; both stay as history.
DROP TABLE IF EXISTS annotations;
