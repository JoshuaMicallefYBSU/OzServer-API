import { describe, expect, it } from "vitest";
import { atisIcao, vatpacAtis, type VatsimAtis } from "./network-atis.js";

const entry = (callsign: string, extra: Partial<VatsimAtis> = {}): VatsimAtis =>
  ({ cid: 1234567, callsign, frequency: "128.300", atis_code: "A", text_atis: ["SYDNEY INFORMATION A"], ...extra });

describe("atisIcao", () => {
  it("reads the airport from plain and suffixed ATIS callsigns", () => {
    expect(atisIcao("YSSY_ATIS")).toBe("YSSY");
    expect(atisIcao("yssy_d_atis")).toBe("YSSY");
  });

  it("rejects callsigns that are not an airport ATIS", () => {
    expect(atisIcao("SY_APP")).toBeNull();
    expect(atisIcao("ML-TBD_CTR")).toBeNull();
    expect(atisIcao("YSSY_TWR")).toBeNull();
  });
});

describe("vatpacAtis", () => {
  it("keeps Australian airports and dataset airports, drops everything else", () => {
    const result = vatpacAtis([entry("YSSY_ATIS"), entry("NZAA_ATIS"), entry("EGLL_ATIS"), entry("AGGH_ATIS")], new Set(["AGGH"]));
    expect(result.map(atis => atis.callsign)).toEqual(["YSSY_ATIS", "AGGH_ATIS"]);
  });

  it("keeps an arrival and a departure ATIS for the same airport as separate stations", () => {
    expect(vatpacAtis([entry("YSSY_ATIS"), entry("YSSY_D_ATIS")], new Set()).map(atis => atis.icao)).toEqual(["YSSY", "YSSY"]);
  });

  it("normalises a missing letter and text", () => {
    expect(vatpacAtis([entry("YMML_ATIS", { atis_code: null, text_atis: null })], new Set())[0])
      .toMatchObject({ icao: "YMML", atis_code: null, text_atis: [] });
  });
});
