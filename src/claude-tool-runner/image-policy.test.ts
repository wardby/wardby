import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Claude tool runner image policy", () => {
  it("pins every stage and contains neither agent runtime nor network client tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const lockfile = await readFile(new URL("./package-lock.json", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from.length).toBeGreaterThan(1);
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line))).toBe(true);
    expect(dockerfile).not.toContain("claude-agent-sdk");
    expect(dockerfile).not.toContain("ANTHROPIC_API_KEY");
    expect(lockfile).not.toContain("@anthropic-ai/");
    expect(dockerfile).toContain("USER 10001:10001");
  });
});
