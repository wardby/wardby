import { describe, expect, it } from "vitest";
import { MAX_CODING_TESTS, parseCodingAgentOutputJson } from "../coding/protocol.js";
import { codingOutputJsonSchema } from "../coding-worker/output-schema.js";
import {
  escapeGeminiAtReferences,
  GEMINI_DROPPED_SCHEMA_KEYWORDS,
  geminiOutputJsonSchema,
  geminiRepairPrompt,
  geminiTaskPrompt,
} from "./output.js";

/** Every key at every depth of a schema, as dotted paths of keywords and property names. */
function keywordsOf(schema: unknown, at = ""): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties") {
      for (const [name, inner] of Object.entries(value as Record<string, unknown>))
        out.push(...keywordsOf(inner, `${at}${name}.`));
    } else if (key === "items") out.push(...keywordsOf(value, `${at}[].`));
    else out.push(`${at}${key}`);
  }
  return out;
}

const valid = {
  schemaVersion: 1,
  runId: "run_g",
  outcome: "changes_ready",
  summary: "ok",
  tag: null,
  commitType: "fix",
  commitScope: null,
  commitTitle: "fix it",
  pullRequest: null,
  tests: [],
};

describe("geminiOutputJsonSchema", () => {
  for (const multi of [false, true]) {
    it(`is wardby's schema without the dropped keywords, nothing else changed (multi=${multi})`, () => {
      const original = keywordsOf(codingOutputJsonSchema(multi));
      const gemini = keywordsOf(geminiOutputJsonSchema(multi));
      const dropped = original.filter((path) => GEMINI_DROPPED_SCHEMA_KEYWORDS.includes(path.split(".").at(-1)!));
      expect(dropped.length).toBeGreaterThan(0);
      expect(gemini).toEqual(original.filter((path) => !dropped.includes(path)));
      expect(JSON.stringify(geminiOutputJsonSchema(multi))).not.toContain('"maxItems"');
    });
  }

  it("drops only what Gemini was seen to refuse (Task 17 adds any other)", () => {
    expect(GEMINI_DROPPED_SCHEMA_KEYWORDS).toEqual(["maxItems"]);
  });

  it("still enforces every dropped limit with wardby's own schema", () => {
    const enforced: Record<string, unknown> = {
      maxItems: {
        ...valid,
        tests: Array.from({ length: MAX_CODING_TESTS + 1 }, () => ({ command: "npm test", outcome: "passed" })),
      },
    };
    for (const keyword of GEMINI_DROPPED_SCHEMA_KEYWORDS) {
      expect(enforced[keyword], `add a violating example for ${keyword}`).toBeDefined();
      expect(() => parseCodingAgentOutputJson(JSON.stringify(enforced[keyword]))).toThrow();
    }
    expect(parseCodingAgentOutputJson(JSON.stringify(valid)).outcome).toBe("changes_ready");
  });
});

describe("prompts", () => {
  it("puts the security instructions first, then the task, then the schema; never starts with a slash", () => {
    const prompt = geminiTaskPrompt({ instructions: "RULES", task: "TASK", schema: { type: "object" } });
    expect(prompt.indexOf("RULES")).toBe(0);
    expect(prompt.indexOf("TASK")).toBeGreaterThan(prompt.indexOf("RULES"));
    expect(prompt).toContain('{"type":"object"}');
    expect(geminiTaskPrompt({ instructions: "/cmd", task: "t", schema: {} }).startsWith("/")).toBe(false);
    expect(geminiRepairPrompt("run_g")).toContain("run_g");
    expect(geminiRepairPrompt("run_g").startsWith("/")).toBe(false);
  });
});

/**
 * 0.70.0 reads an @-reference (a file, an agent or an MCP resource) only at an "@" that no backslash
 * precedes: an unescaped "@" is the one thing that must never reach it.
 */
const UNESCAPED_AT = /(?<!\\)@/g;

describe("@ references", () => {
  it.each([
    ["mail a@b.com", "mail a\\@b.com"],
    ["See @README.md", "See \\@README.md"],
    ["@/etc/passwd", "\\@/etc/passwd"],
    ["read @~/x now", "read \\@~/x now"],
    ['@"a file.md"', '\\@"a file.md"'],
    ["@codebase_investigator do it", "\\@codebase_investigator do it"],
    ["@wardby_mcp:res://x", "\\@wardby_mcp:res://x"],
    ["\\@already", "\\@already"],
    ["a@@b", "a\\@\\@b"],
    ["trailing @", "trailing \\@"],
  ])("escapes %j so the CLI matches no reference", (raw, escaped) => {
    expect(escapeGeminiAtReferences(raw)).toBe(escaped);
    expect(escapeGeminiAtReferences(raw).match(UNESCAPED_AT)).toBeNull();
  });

  it("escapes the whole task prompt (instructions, task, schema) and the repair prompt", () => {
    const prompt = geminiTaskPrompt({
      instructions: "rules @GEMINI.md",
      task: "See @README.md",
      schema: { description: "x@y" },
    });
    expect(prompt.match(UNESCAPED_AT)).toBeNull();
    expect(prompt).toContain("rules \\@GEMINI.md");
    expect(prompt).toContain("See \\@README.md");
    expect(prompt).toContain("x\\@y");
    expect(geminiRepairPrompt("run_@x").match(UNESCAPED_AT)).toBeNull();
  });
});
