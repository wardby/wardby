import { describe, expect, it } from "vitest";
import { createPrivilegedHost, redactExactSecretValues, secretSpans, withEscapedForms } from "./host-functions.js";
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

describe("console bridge redacts each value's escaped form too", () => {
  const PEM = "-----BEGIN FAKE KEY-----\nZmFrZS1wZW0tYm9keS0wMDAx\n-----END FAKE KEY-----";
  const QUOTED = 'fake"quoted\\value\t0007';
  /** What the console bridge logs for `logArgs`, given the values it may redact. */
  async function consoleLine(logArgs: unknown[], values: readonly string[]): Promise<string> {
    const lines: string[] = [];
    const log = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    };
    const host = createPrivilegedHost({
      agentId: "agent_1",
      datastore: {} as never,
      sharedDatastore: {} as never,
      logTag: "t",
      logger: { child: () => log } as never,
      redactSecretValues: values,
    });
    await host.__bridge_console(JSON.stringify(["info", logArgs]));
    return lines.join("\n");
  }

  it("masks a multi-line PEM-shaped value and a value with a quote, backslash and tab", async () => {
    const line = await consoleLine([`key ${PEM}`, { nested: QUOTED }], [PEM, QUOTED]);
    const forms = [PEM, QUOTED].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
    expect(holdsValueFragment(line, forms)).toBe(false);
    expect(line.includes("[REDACTED]")).toBe(true);
  });
});

describe("withEscapedForms", () => {
  it("adds each value's JSON-escaped form when it differs", () => {
    expect(withEscapedForms(["plain-value", 'a"b\nc'])).toEqual(["plain-value", 'a"b\nc', 'a\\"b\\nc']);
  });
});
