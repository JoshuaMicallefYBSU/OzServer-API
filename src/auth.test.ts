import { describe, expect, it } from "vitest";
import { parseControllerIdentity, parseServer } from "./auth.js";

describe("parseControllerIdentity", () => {
  it("accepts any valid CID and callsign without an external verification lookup", () => {
    expect(parseControllerIdentity({ controller_cid: "1234567", controller_callsign: "sy_app", server: "live" }))
      .toEqual({ cid: 1234567, callsign: "SY_APP", server: "live" });
  });

  it("rejects missing or malformed operational identity fields", () => {
    expect(parseControllerIdentity({ controller_cid: 1234567, server: "live" })).toBeNull();
    expect(parseControllerIdentity({ controller_cid: 0, controller_callsign: "SY_APP", server: "live" })).toBeNull();
  });

  it("requires a server", () => {
    expect(parseControllerIdentity({ controller_cid: 1234567, controller_callsign: "SY_APP" })).toBeNull();
  });

  it("rejects a server outside the allowlist", () => {
    expect(parseControllerIdentity({ controller_cid: 1234567, controller_callsign: "SY_APP", server: "sb3" })).toBeNull();
    expect(parseControllerIdentity({ controller_cid: 1234567, controller_callsign: "SY_APP", server: "production" })).toBeNull();
  });

  it("is case-sensitive about the server slug", () => {
    expect(parseControllerIdentity({ controller_cid: 1234567, controller_callsign: "SY_APP", server: "Live" })).toBeNull();
  });

  it("accepts every allowlisted server", () => {
    for (const server of ["live", "sb1", "sb2", "newsb"]) {
      expect(parseControllerIdentity({ controller_cid: 1234567, controller_callsign: "SY_APP", server }))
        .toEqual({ cid: 1234567, callsign: "SY_APP", server });
    }
  });
});

describe("parseServer", () => {
  it("accepts an allowlisted value", () => {
    expect(parseServer("sb1")).toBe("sb1");
  });

  it("rejects anything else", () => {
    expect(parseServer("sb3")).toBeNull();
    expect(parseServer("Live")).toBeNull();
    expect(parseServer(undefined)).toBeNull();
    expect(parseServer(123)).toBeNull();
  });
});
