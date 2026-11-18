import { describe, expect, it } from "vitest";
import {
  BRISBANE, controllersEmbed, firResolver, firTagsEmbed, MELBOURNE, sortFirs, UNKNOWN_FIR,
  type SectorRow
} from "./live-stats-format.js";

const sector = (name: string, callsign: string | null, children: string[] = []): SectorRow =>
  ({ name, callsign, type: null, frequency: null, responsible_sectors: children });

const sectors = [
  sector("BLA", "ML-BLA_CTR", ["ELW", "MAE"]),
  sector("MAE", "ML_APP", ["MAE", "MAV"]),
  sector("MAV", "ML_APP"),
  sector("ELW", "ML-ELW_CTR"),
  sector("TRT", "BN-TRT_CTR", ["TRS", "DAE"]),
  sector("TRS", "BN-TRS_CTR"),
  sector("DAE", "BN-DAE_APP"),
  sector("WAAF", "WAAF_CTR")
];

describe("firResolver", () => {
  const fir = firResolver(sectors);

  it("reads an enroute sector's FIR from its callsign", () => {
    expect(fir("ELW")).toBe(MELBOURNE);
    expect(fir("TRS")).toBe(BRISBANE);
  });

  it("takes a TMA sector's FIR from the enroute group covering it, however deep", () => {
    expect(fir("MAE")).toBe(MELBOURNE);
    expect(fir("MAV")).toBe(MELBOURNE);
  });

  it("names the foreign FIRs in the dataset, and anything else as unknown", () => {
    expect(fir("WAAF")).toBe("Ujung Pandang FIR (WAAF)");
    expect(fir("NOPE")).toBe(UNKNOWN_FIR);
    expect(fir(null)).toBe(UNKNOWN_FIR);
  });
});

describe("sortFirs", () => {
  it("puts Melbourne and Brisbane first and unknown last", () => {
    const entry = (fir: string) => ({ fir, tracked: [], untracked: ["X"] });
    expect(sortFirs([entry(UNKNOWN_FIR), entry("Jakarta FIR (WIIF)"), entry(BRISBANE), entry(MELBOURNE)])
      .map(item => item.fir)).toEqual([MELBOURNE, BRISBANE, "Jakarta FIR (WIIF)", UNKNOWN_FIR]);
  });
});

describe("embeds", () => {
  const now = new Date("2026-11-18T06:00:00Z");

  it("lists each controller with their extensions and tags", () => {
    const embed = controllersEmbed([{
      callsign: "BN-TRS_CTR", sector: "TRS", type: "CTR", frequency: "135.700",
      onOzServer: true, extending: ["TRT"], tags: ["QFA1", "VOZ2"]
    }], now);
    expect(embed.description).toContain("**BN-TRS_CTR** — TRS · 135.700 · 🟢 OzServer");
    expect(embed.description).toContain("Extending: TRT");
    expect(embed.description).toContain("Tags (2): QFA1, VOZ2");
    expect(embed.footer?.text).toContain("1 online · 1 on OzServer · 2 tags tracked");
    expect(embed.timestamp).toBe(now.toISOString());
  });

  it("stays inside Discord's description limit however many controllers there are", () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      callsign: `ML-X${index}_CTR`, sector: `X${index}`, type: "CTR", frequency: "120.000",
      onOzServer: false, extending: [], tags: Array.from({ length: 30 }, (__, tag) => `TAG${tag}`)
    }));
    const embed = controllersEmbed(many, now);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.description).toMatch(/\.\.\. and \d+ more$/);
  });

  it("groups each FIR's tags by controller, with the untracked after", () => {
    const embed = firTagsEmbed([{
      fir: MELBOURNE,
      tracked: [{ callsign: "QFA1", by: "ML-BLA_CTR" }, { callsign: "VOZ2", by: "ML-BLA_CTR" }],
      untracked: ["JST3"]
    }], now);
    expect(embed.fields).toEqual([{
      name: `${MELBOURNE} — 3 aircraft`,
      value: "**Tracked (2)**\nML-BLA_CTR: QFA1, VOZ2\n**Untracked (1)**\nJST3"
    }]);
  });

  it("says so when nothing is being reported", () => {
    expect(controllersEmbed([], now).description).toBe("No Australian controllers are online.");
    expect(firTagsEmbed([], now).description).toBe("No flights are being reported by OzServer clients.");
  });
});
