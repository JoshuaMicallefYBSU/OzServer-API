-- Which airspace region a sector or position belongs to - the banner it is grouped under on the
-- map: 'australia' (the vatSys Australia and Pacific datasets) or 'mexico' (the vatSys Mexico
-- dataset). Set by sync-dataset.ts; the list itself lives in src/regions.ts. Free text, like
-- `server`, so adding a region is a code change, not a migration.
--
-- Everything already here came from the Australia and Pacific datasets, hence the default.
ALTER TABLE sectors   ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'australia';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'australia';
CREATE INDEX IF NOT EXISTS sectors_region_idx ON sectors (region);
