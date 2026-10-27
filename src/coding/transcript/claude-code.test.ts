import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeClaudeTranscript } from "./claude-code.js";

const fixture = readFileSync(new URL("./fixtures/claude-session.jsonl", import.meta.url), "utf8");
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, any>);

describe("sanitizeClaudeTranscript", () => {
  const result = sanitizeClaudeTranscript(fixture)!;
  const records = parse(result.lines);
  const text = result.lines.join("\n");

  it("keeps only conversation records and the title", () => {
    expect(records.map((r) => r.type)).toEqual(["user", "assistant", "user", "assistant", "ai-title"]);
    expect(result.sessionId).toBe("00000000-0000-4000-8000-000000000001");
  });
  it("drops prompts, environment, account and budget data", () => {
    for (const leak of [
      "SYSTEM PROMPT TEXT",
      "person@example.com",
      "11111111-1111-4111-8111-111111111111",
      "toolUseResult",
      "cost-state",
    ]) {
      expect(text).not.toContain(leak);
    }
  });
  it("strips thinking blocks and drops records left empty", () => {
    expect(text).not.toContain('"thinking"');
    expect(records.find((r) => r.uuid === "t1")).toBeUndefined();
  });
  it("relinks parents across dropped records", () => {
    expect(records.find((r) => r.uuid === "t2")!.parentUuid).toBe("u1");
  });
  it("trims to the last complete assistant turn", () => {
    expect(records.find((r) => r.uuid === "t3")).toBeUndefined();
    expect(records.at(-2)!.uuid).toBe("f1");
  });
  it("returns null without a complete turn", () => {
    const firstTwo = fixture.split("\n").slice(0, 2).join("\n");
    expect(sanitizeClaudeTranscript(firstTwo)).toBeNull();
  });
  it("is idempotent", () => {
    expect(sanitizeClaudeTranscript(result.lines.join("\n"))!.lines).toEqual(result.lines);
  });
});
