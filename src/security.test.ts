import { describe, expect, it } from "vitest";
import { secureTokenMatches } from "./security.js";

describe("secureTokenMatches", () => {
  it("accepts an exact token", () => expect(secureTokenMatches("secret-value", "secret-value")).toBe(true));
  it("rejects a different token", () => expect(secureTokenMatches("secret-other", "secret-value")).toBe(false));
  it("rejects missing and differently sized tokens", () => {
    expect(secureTokenMatches(undefined, "secret-value")).toBe(false);
    expect(secureTokenMatches("short", "secret-value")).toBe(false);
  });
});
