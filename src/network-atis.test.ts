import { describe, expect, it } from "vitest";
import { atisChangedSections, atisSectionContent, atisTimestamp, atisUpdateSchema } from "./network-atis.js";

// A complete, valid PUT body - the one in the plugin's API notes - which each test then varies.
const body = (extra: Record<string, unknown> = {}) => ({
  icao: "YSSY",
  callsign: "YSSY_ATIS",
  atis_letter: "N",
  type: "atis",
  frequency: "126.250",
  issued: "2026-11-12T09:14:00Z",
  content: {
    "APCH": "EXP INST APCH",
    "RWY": "34L FOR ARRS, RWY 34R FOR DEPS",
    "SFC COND": null,
    "OPR INFO": "INDEPENDENT PARALLEL APPROACHES IN PROGRESS",
    "WIND": "320/15-25, MX XW 14KTS",
    "VIS": "GT 10KM",
    "WX": null,
    "CLD": "FEW030",
    "TMP": "18",
    "QNH": "1013",
    "SIGWX": null
  },
  changed: ["WIND", "QNH"],
  controller: { callsign: "SY_TWR", cid: "1234567" },
  client: { name: "vatSys ATIS Plugin", version: "4.3" },
  ...extra
});

const parse = (input: Record<string, unknown>) => atisUpdateSchema.safeParse(input);
const accepted = (input: Record<string, unknown>) => {
  const result = parse(input);
  if (!result.success) throw new Error(`Expected a valid ATIS: ${result.error.message}`);
  return result.data;
};

describe("atisUpdateSchema", () => {
  it("accepts the published body and normalises its identifiers", () => {
    const atis = accepted(body({ icao: "yssy", callsign: "yssy_atis", atis_letter: "n", type: "ATIS" }));
    expect(atis).toMatchObject({
      icao: "YSSY",
      callsign: "YSSY_ATIS",
      atis_letter: "N",
      type: "atis",
      frequency: "126.250",
      controller: { callsign: "SY_TWR", cid: 1234567 },
      client: { name: "vatSys ATIS Plugin", version: "4.3" }
    });
    expect(atis.issued.toISOString()).toBe("2026-11-12T09:14:00.000Z");
  });

  it("keeps a zulu broadcast's text as its content, with nothing marked changed", () => {
    const atis = accepted(body({
      type: "zulu",
      content: "CANBERRA TOWER IS CLOSED ... CONTACT CANBERRA APPROACH ON 124.500 ...",
      changed: ["RWY"]
    }));
    expect(atis.content).toBe("CANBERRA TOWER IS CLOSED ... CONTACT CANBERRA APPROACH ON 124.500 ...");
    expect(atis.changed).toEqual([]);
  });

  it("refuses content that does not match the type it was published as", () => {
    expect(parse(body({ type: "zulu" })).success).toBe(false);
    expect(parse(body({ content: "JUST TEXT" })).success).toBe(false);
  });

  it("refuses a broadcast with nothing in it", () => {
    expect(parse(body({ content: {} })).success).toBe(false);
    expect(parse(body({ content: { "RWY": null, "QNH": "" } })).success).toBe(false);
    // A section this API does not serve is not a broadcast either - it is dropped, not stored.
    expect(parse(body({ content: { "MODE": "34 PROPS IVA" } })).success).toBe(false);
    expect(parse(body({ type: "zulu", content: "   " })).success).toBe(false);
  });

  it("refuses a broadcast with no letter, a letter that is not one, or no airport", () => {
    expect(parse(body({ atis_letter: null })).success).toBe(false);
    expect(parse(body({ atis_letter: " " })).success).toBe(false);
    expect(parse(body({ atis_letter: "NA" })).success).toBe(false);
    expect(parse(body({ icao: "YSS" })).success).toBe(false);
  });

  it("takes a frequency as published, or none at all, but not a malformed one", () => {
    expect(accepted(body({ frequency: null })).frequency).toBeNull();
    expect(accepted(body({ frequency: undefined })).frequency).toBeNull();
    expect(accepted(body({ frequency: "118.1" })).frequency).toBe("118.1");
    expect(parse(body({ frequency: "one two six" })).success).toBe(false);
  });

  it("refuses a body with no controller behind it, or an unusable time", () => {
    expect(parse(body({ controller: undefined })).success).toBe(false);
    expect(parse(body({ controller: { callsign: "SY_TWR" } })).success).toBe(false);
    expect(parse(body({ issued: "not a time" })).success).toBe(false);
  });

  it("treats the client as optional telemetry", () => {
    expect(accepted(body({ client: undefined })).client).toBeNull();
  });
});

describe("atisSectionContent", () => {
  it("returns every section in editor order, null for the ones not broadcast", () => {
    expect(atisSectionContent({ QNH: "1013", RWY: "34L" })).toEqual({
      "APCH": null, "RWY": "34L", "SFC COND": null, "OPR INFO": null, "WIND": null,
      "VIS": null, "WX": null, "CLD": null, "TMP": null, "QNH": "1013", "SIGWX": null
    });
  });

  it("accepts a tag however vatSys spelled it, and drops one this API does not serve", () => {
    const content = atisSectionContent({ "SFC_COND": "WET", "sfc cond": "WET", "MODE": "34 PROPS IVA" });
    expect(content["SFC COND"]).toBe("WET");
    expect(Object.keys(content)).not.toContain("MODE");
  });

  it("reads an empty or whitespace-only section as not broadcast", () => {
    expect(atisSectionContent({ RWY: "", QNH: "   " })).toMatchObject({ RWY: null, QNH: null });
  });
});

describe("atisChangedSections", () => {
  it("lists the changed sections in editor order, deduplicated, known ones only", () => {
    expect(atisChangedSections(["QNH", "wind", "MODE", "WIND"])).toEqual(["WIND", "QNH"]);
  });

  it("is empty when the letter changed nothing", () => {
    expect(atisChangedSections([])).toEqual([]);
  });
});

describe("atisTimestamp", () => {
  it("formats an instant as a UTC day-time group", () => {
    expect(atisTimestamp("2026-11-12T09:14:00Z")).toBe("120914z");
    expect(atisTimestamp(new Date(Date.UTC(2026, 10, 1, 0, 5)))).toBe("010005z");
  });

  it("passes through a missing or unreadable timestamp as null", () => {
    expect(atisTimestamp(null)).toBeNull();
    expect(atisTimestamp(undefined)).toBeNull();
    expect(atisTimestamp("not a date")).toBeNull();
  });
});
