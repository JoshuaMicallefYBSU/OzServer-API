import { describe, expect, it } from "vitest";
import { parseControllerIdentity } from "./auth.js";

describe("parseControllerIdentity", () => {
  it("accepts any valid CID and callsign without an external verification lookup", () => {
    expect(parseControllerIdentity({ controller_cid: "1234567", controller_callsign: "sy_app" }))
      .toEqual({ cid: 1234567, callsign: "SY_APP" });
  });

  it("rejects missing or malformed operational identity fields", () => {
    expect(parseControllerIdentity({ controller_cid: 1234567 })).toBeNull();
    expect(parseControllerIdentity({ controller_cid: 0, controller_callsign: "SY_APP" })).toBeNull();
  });
});
