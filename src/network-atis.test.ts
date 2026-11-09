import { describe, expect, it } from "vitest";
import { atisContent, atisIcao, vatpacAtis, type VatsimAtis } from "./network-atis.js";

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

describe("atisContent", () => {
  const ymml = [
    "ATIS YMML V 090232",
    "+[APCH] AIRCRAFT ON THE ALPHA STAR EXP GLS OR RNP APCH",
    "[RWY] 34",
    "[WIND] 290-020/5",
    "[WX] CAVOK",
    "[TMP] 20",
    "[QNH] 1020"
  ];

  it("splits the text into its sections without the tags or change markers", () => {
    expect(atisContent(ymml)).toEqual({
      "APCH": "AIRCRAFT ON THE ALPHA STAR EXP GLS OR RNP APCH",
      "RWY": "34",
      "SFC COND": null,
      "OPR INFO": null,
      "WIND": "290-020/5",
      "VIS": null,
      "WX": "CAVOK",
      "CLD": null,
      "TMP": "20",
      "QNH": "1020",
      "SIGWX": null
    });
  });

  it("drops MODE, OFCW_NOTIFY and TIME_CHECK without letting them leak into a neighbouring section", () => {
    const content = atisContent(["[MODE] 34 PROPS IVA", "[RWY] 34L AND R", "[OFCW_NOTIFY] GROUND OR APPROACH"]);
    expect(content.RWY).toBe("34L AND R");
    expect(Object.keys(content)).not.toContain("MODE");
  });

  it("joins a section the text wraps across lines and accepts underscore tag names", () => {
    const content = atisContent(["[SFC_COND] WET", "[SIGWX] WIND SHEAR WARNING, A320 REPORTED", "MODERATE OVERSHOOT"]);
    expect(content["SFC COND"]).toBe("WET");
    expect(content.SIGWX).toBe("WIND SHEAR WARNING, A320 REPORTED MODERATE OVERSHOOT");
  });
});
