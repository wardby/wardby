import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./fixtures/stream/", import.meta.url);
const scenarios = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -5));

describe("recorded Gemini CLI 0.70.0 output", () => {
  it("has every scenario the driver's tests read", () => {
    expect(scenarios.sort()).toEqual(
      [
        "bad-settings",
        "budget-limit0",
        "e400",
        "e401",
        "e403",
        "e404",
        "e500",
        "e503",
        "helper-refused",
        "prose-final",
        "rate-limited",
        "repair-json",
        "success-tools",
        "tool-error",
        "turn-limit",
        "unknown-flag",
      ].sort(),
    );
  });

  it("was recorded from the pinned CLI and holds no key or local path", () => {
    for (const scenario of scenarios) {
      const meta = JSON.parse(readFileSync(new URL(`${scenario}.json`, dir), "utf8"));
      expect(meta.cli).toBe("0.70.0");
      const all = readFileSync(new URL(`${scenario}.jsonl`, dir), "utf8") + meta.stderrTail;
      expect(all, scenario).not.toMatch(/fake-placeholder|AIza[0-9A-Za-z_-]{20,}|\/Users\//);
    }
  });
});
