import { describe, expect, it } from "vitest";
import { redactExactSecretValues, secretSpans } from "./host-functions.js";
import { holdsValueFragment } from "./secret-fragments.test-support.js";

// Fake values only. Every assertion compares booleans or marker-only text, so a failure cannot print a value.
describe("redactExactSecretValues masks the union of every occurrence", () => {
  it("masks a self-overlapping value repeated past one occurrence", () => {
    const value = "abcabcabc";
    const out = redactExactSecretValues("abc".repeat(5), [value]);
    expect(holdsValueFragment(out, [value])).toBe(false);
    expect(out === "[REDACTED]").toBe(true);
  });

  it("masks a value whose occurrences overlap by more than a period", () => {
    const value = "s3cr3ts";
    const out = redactExactSecretValues("x s3cr3ts3cr3ts y", [value]);
    expect(holdsValueFragment(out, [value])).toBe(false);
    expect(out === "x [REDACTED] y").toBe(true);
  });

  it("masks two different values that overlap each other", () => {
    const first = "fake-alpha-beta";
    const second = "beta-gamma-fake";
    const out = redactExactSecretValues("< fake-alpha-beta-gamma-fake >", [first, second]);
    expect(holdsValueFragment(out, [first, second])).toBe(false);
    expect(out === "< [REDACTED] >").toBe(true);
  });

  it("masks adjacent occurrences as one marker", () => {
    const value = "fake-token-0001";
    const out = redactExactSecretValues(`a ${value}${value} b`, [value]);
    expect(holdsValueFragment(out, [value])).toBe(false);
    expect(out === "a [REDACTED] b").toBe(true);
  });

  it("leaves a value below the minimum length alone", () => {
    expect(redactExactSecretValues("short abcde here", ["abcde"])).toBe("short abcde here");
  });

  it("masks a value's raw and JSON-escaped forms together", () => {
    const value = 'fake"quoted\nvalue';
    const escaped = JSON.stringify(value).slice(1, -1);
    const out = redactExactSecretValues(`raw ${value} esc ${escaped}`, [value, escaped]);
    expect(holdsValueFragment(out, [value, escaped])).toBe(false);
    expect(out === "raw [REDACTED] esc [REDACTED]").toBe(true);
  });
});

describe("secretSpans", () => {
  it("returns the merged, sorted spans of every occurrence, overlapping ones included", () => {
    expect(secretSpans("abc".repeat(5), ["abcabcabc"])).toEqual([[0, 15]]);
    expect(secretSpans("x fake-token-0001 y fake-token-0001", ["fake-token-0001"])).toEqual([
      [2, 17],
      [20, 35],
    ]);
    expect(secretSpans("ab fake-alpha-beta-gamma-fake", ["beta-gamma-fake", "fake-alpha-beta"])).toEqual([[3, 29]]);
  });

  it("ignores values below the minimum length", () => {
    expect(secretSpans("abcde abcde", ["abcde"])).toEqual([]);
  });
});
