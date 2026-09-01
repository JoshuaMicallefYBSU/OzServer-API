import { timingSafeEqual } from "node:crypto";

export function secureTokenMatches(actualValue: string | undefined, expectedValue: string): boolean {
  if (actualValue === undefined) return false;
  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
