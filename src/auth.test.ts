import { describe, expect, it } from "vitest";
import { controllerIsOnline } from "./auth.js";

const online = new Map<string, number>([
  ["SY_APP", 1234567],
  ["ML_CTR", 7654321]
]);

describe("controllerIsOnline", () => {
  it("accepts an exact CID and callsign pair", () => {
    expect(controllerIsOnline(online, 1234567, "SY_APP")).toBe(true);
    expect(controllerIsOnline(online, 1234567, "sy_app")).toBe(true);
  });

  it("rejects a CID borrowed from a different online controller", () => {
    expect(controllerIsOnline(online, 7654321, "SY_APP")).toBe(false);
  });

  it("rejects an offline callsign", () => {
    expect(controllerIsOnline(online, 1234567, "BN_APP")).toBe(false);
  });
});
