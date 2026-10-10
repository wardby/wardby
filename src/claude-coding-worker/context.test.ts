import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bareModeContextPrompt, materializeClaudeContext } from "./context.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))));
async function parent() {
  const dir = await mkdtemp(join(tmpdir(), "wardby-ctx-"));
  roots.push(dir);
  return dir;
}

describe("materializeClaudeContext", () => {
  it("returns null for no files", async () => {
    expect(await materializeClaudeContext([], join(tmpdir(), "unused"))).toBeNull();
  });

  it("writes files under a fresh root and reports skills", async () => {
    const root = join(await parent(), "ctx");
    const result = await materializeClaudeContext(
      [
        { path: "CLAUDE.md", content: "c" },
        { path: ".claude/skills/a/SKILL.md", content: "s" },
      ],
      root,
    );
    expect(result).toEqual({ directory: root, skills: true });
    expect(await readFile(join(root, ".claude/skills/a/SKILL.md"), "utf8")).toBe("s");
  });

  it("reports no skills when only instructions are present", async () => {
    const root = join(await parent(), "ctx");
    expect(await materializeClaudeContext([{ path: "CLAUDE.md", content: "c" }], root)).toMatchObject({
      skills: false,
    });
  });

  it("silently drops files outside the allowlist", async () => {
    const root = join(await parent(), "ctx");
    const result = await materializeClaudeContext(
      [
        { path: "CLAUDE.md", content: "c" },
        { path: ".claude/settings.json", content: "{}" },
        { path: ".mcp.json", content: "{}" },
        { path: "CLAUDE.local.md", content: "l" },
        { path: ".claude/agents/x.md", content: "a" },
      ],
      root,
    );
    expect(result).toEqual({ directory: root, skills: false });
    expect(await readdir(root, { recursive: true })).toEqual(["CLAUDE.md"]);
  });

  it("returns null when every file is outside the allowlist", async () => {
    const root = join(await parent(), "ctx");
    expect(await materializeClaudeContext([{ path: ".claude/settings.json", content: "{}" }], root)).toBeNull();
    await expect(readdir(root)).rejects.toThrow();
  });

  it("refuses to reuse an existing root", async () => {
    await expect(materializeClaudeContext([{ path: "CLAUDE.md", content: "c" }], await parent())).rejects.toThrow(
      "claude_context_root_exists",
    );
  });
});

describe("bareModeContextPrompt", () => {
  it("is empty without files", () => {
    expect(bareModeContextPrompt([])).toBe("");
  });

  it("renders instructions then the skill list", () => {
    const prompt = bareModeContextPrompt([
      { path: "CLAUDE.md", content: "Use pnpm." },
      { path: "docs/a.md", content: "Imported." },
      { path: ".claude/skills/lint/SKILL.md", content: '---\nname: lint\ndescription: "Run the linter"\n---\nbody' },
      { path: ".claude/skills/bare/SKILL.md", content: "no frontmatter" },
    ]);
    expect(prompt).toContain("# Repository instructions");
    expect(prompt).toContain("## CLAUDE.md\n\nUse pnpm.");
    expect(prompt).toContain("## docs/a.md\n\nImported.");
    expect(prompt).toContain("# Repository skills");
    expect(prompt).toContain("- lint: Run the linter (/workspace/.claude/skills/lint/SKILL.md)");
    expect(prompt).toContain("- bare (/workspace/.claude/skills/bare/SKILL.md)");
    expect(prompt.indexOf("# Repository instructions")).toBeLessThan(prompt.indexOf("# Repository skills"));
    expect(prompt).not.toContain("body");
  });

  it("leaves out files outside the allowlist", () => {
    const prompt = bareModeContextPrompt([
      { path: "CLAUDE.md", content: "Use pnpm." },
      { path: ".claude/settings.json", content: "SETTINGS-MARKER" },
      { path: ".claude/agents/x.md", content: "AGENT-MARKER" },
    ]);
    expect(prompt).toContain("Use pnpm.");
    expect(prompt).not.toContain("MARKER");
    expect(prompt).not.toContain(".claude/settings.json");
    expect(bareModeContextPrompt([{ path: ".mcp.json", content: "{}" }])).toBe("");
  });

  it("renders only skills when there are no instruction files", () => {
    const prompt = bareModeContextPrompt([{ path: ".claude/skills/x/SKILL.md", content: "---\nname: x\n---\n" }]);
    expect(prompt).not.toContain("# Repository instructions");
    expect(prompt).toContain("- x (/workspace/.claude/skills/x/SKILL.md)");
  });
});
