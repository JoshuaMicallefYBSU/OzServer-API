// The airspace regions OzServer covers, each a banner the map groups sectors, aircraft and ATIS
// under (sectors.region / positions.region - see migrations/015_regions.sql):
//
//   australia - the vatSys Australia and Pacific datasets
//   mexico    - the VATMEX MMFR sector (vatmex/vatmex-mmfr-sector)
//
// Which dataset fills which region is decided in commands/sync-dataset.ts. Served at /regions so the
// map builds its toggles from this list rather than keeping its own copy.
export const REGIONS = [
  { value: "australia", label: "Australia" },
  { value: "mexico", label: "Mexico" }
] as const;

export type Region = typeof REGIONS[number]["value"];
