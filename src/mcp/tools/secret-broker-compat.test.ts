import { describe, expect, it } from "vitest";
import { brokerCompatibilityWarnings, toolCallsSecretsGet } from "./secret-broker-compat.js";

describe("broker compatibility", () => {
  it("detects secrets.get calls", () => {
    expect(toolCallsSecretsGet("const k = await secrets.get('GH');")).toBe(true);
    expect(toolCallsSecretsGet("const k = await secrets . get ('GH');")).toBe(true);
    expect(toolCallsSecretsGet("await fetch(u, { secrets: ['GH'] });")).toBe(false);
  });
  it("warns only for tools granted a brokered secret that call secrets.get", () => {
    const warnings = brokerCompatibilityWarnings(
      [
        { name: "old", code: "await secrets.get('GH')", allowedSecrets: ["GH"] },
        { name: "new", code: "await fetch(u, { secrets: ['GH'] })", allowedSecrets: ["GH"] },
        { name: "other", code: "await secrets.get('X')", allowedSecrets: ["X"] },
      ],
      new Set(["GH"]),
    );
    expect(warnings).toEqual([
      'Tool "old" reads secrets with secrets.get(), but "GH" is brokered: that call will fail with secret_brokered. Update the tool to send it with fetch(url, { secrets: ["GH"] }).',
    ]);
  });
});
