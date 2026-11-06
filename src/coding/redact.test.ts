import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts exact values and token-shaped values", () => {
    const out = redactSecrets("key=fake-value-1234567890 Bearer abc.def rrp_abcdefghij", ["fake-value-1234567890"]);
    expect(out).not.toContain("fake-value-1234567890");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("rrp_abcdefghij");
    expect(out).toContain(REDACTED);
  });

  it("redacts a coding run's MCP token", () => {
    const token = `rmt_${"Q".repeat(43)}`;
    const out = redactSecrets(`token ${token} and rmt_${"z".repeat(20)}`);
    expect(out).toBe(`token ${REDACTED} and ${REDACTED}`);
  });
});
