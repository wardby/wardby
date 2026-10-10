import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENTS_BRIDGE,
  MAX_IMPORTS_PER_FILE,
  MAX_RECORDED_SKIPS,
  MAX_SKILL_ENTRIES,
  buildClaudeContext,
  importsOf,
} from "./claude-context.js";
import { CLAUDE_CONTEXT_LIMITS } from "./protocol.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))));

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wardby-claude-context-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
const paths = (ctx: { files: { path: string }[] }) => ctx.files.map((f) => f.path);

describe("importsOf", () => {
  it("finds @imports outside code", () => {
    const md = "See @docs/a.md and @b.md.\n```\n@not/this.md\n```\nInline `@nor/this.md` here\n@docs/a.md again";
    expect(importsOf(md)).toEqual(["docs/a.md", "b.md"]);
  });

  it("hides @imports inside inline code spans of any backtick length", () => {
    const md = "a `@one.md` b ``@two.md ` x`` c ```@three.md``` @four.md";
    expect(importsOf(md)).toEqual(["four.md"]);
  });

  it("treats an unmatched backtick run as literal text", () => {
    expect(importsOf("a `` b `@x.md` @y.md")).toEqual(["y.md"]);
    expect(importsOf("stray ` here @x.md")).toEqual(["x.md"]);
  });

  it("does not let an inline code span cross a blank line", () => {
    expect(importsOf("open ` span\n\n@x.md and ` close")).toEqual(["x.md"]);
  });

  it("handles pathological backtick and punctuation runs in linear time", () => {
    let backticks = "x";
    for (let k = 1; backticks.length < 64 * 1024; k++) backticks += "`".repeat(k) + "a";
    const punctuation = "@a" + ".".repeat(64 * 1024) + "x";
    const start = performance.now();
    importsOf(backticks);
    importsOf(punctuation);
    importsOf(" @a" + ".".repeat(64 * 1024));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("ignores ~~~ fences, e-mail addresses, and bare @", () => {
    const md = "~~~\n@fenced.md\n~~~\nmail me@example.com or @ alone; @y.md; @z.md)";
    expect(importsOf(md)).toEqual(["y.md", "z.md"]);
  });
});

describe("buildClaudeContext", () => {
  it("returns nothing for a repo without instructions or skills", async () => {
    expect(await buildClaudeContext(await repo({ "README.md": "x" }), { skills: true })).toEqual({
      files: [],
      skipped: [],
      skippedOverflow: 0,
    });
  });

  it("loads CLAUDE.md, .claude/CLAUDE.md, and nested imports relative to the importer", async () => {
    const root = await repo({
      "CLAUDE.md": "root @docs/a.md",
      ".claude/CLAUDE.md": "inner",
      "docs/a.md": "a @b.md",
      "docs/b.md": "b",
    });
    expect(paths(await buildClaudeContext(root, { skills: false }))).toEqual([
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      "docs/a.md",
      "docs/b.md",
    ]);
  });

  it("bridges AGENTS.md when there is no CLAUDE.md", async () => {
    const ctx = await buildClaudeContext(await repo({ "AGENTS.md": "agents" }), { skills: false });
    expect(ctx.files).toEqual([
      { path: "CLAUDE.md", content: AGENTS_BRIDGE },
      { path: "AGENTS.md", content: "agents" },
    ]);
  });

  it("does not bridge AGENTS.md when CLAUDE.md exists", async () => {
    const ctx = await buildClaudeContext(await repo({ "CLAUDE.md": "c", "AGENTS.md": "a" }), { skills: false });
    expect(paths(ctx)).toEqual(["CLAUDE.md"]);
  });

  it("skips imports that leave the repo or are absolute or home-relative", async () => {
    const ctx = await buildClaudeContext(await repo({ "CLAUDE.md": "@../x.md @/etc/passwd @~/.ssh/id @.git/config" }), {
      skills: false,
    });
    expect(paths(ctx)).toEqual(["CLAUDE.md"]);
    expect(ctx.skipped.map((s) => s.reason)).toEqual(["outside_repo", "outside_repo", "outside_repo", "outside_repo"]);
  });

  it("reports escaping imports as written and in-repo refusals as repo-relative paths", async () => {
    const root = await repo({ "docs/a.md": "@../../x.md @../.git/config", "CLAUDE.md": "@docs/a.md" });
    const ctx = await buildClaudeContext(root, { skills: false });
    expect(ctx.skipped).toEqual([
      { path: "../../x.md", reason: "outside_repo" },
      { path: ".git/config", reason: "outside_repo" },
    ]);
  });

  it("never reads an import outside the allowlist of instruction files", async () => {
    const root = await repo({
      "CLAUDE.md": "@.claude/settings.json @.mcp.json @CLAUDE.local.md @.claude/agents/x.md @notes.txt @docs/a.md",
      ".claude/settings.json": "{}",
      ".mcp.json": "{}",
      "CLAUDE.local.md": "local",
      ".claude/agents/x.md": "agent",
      "notes.txt": "notes",
      "docs/a.md": "a",
    });
    const ctx = await buildClaudeContext(root, { skills: false });
    expect(paths(ctx)).toEqual(["CLAUDE.md", "docs/a.md"]);
    expect(ctx.skipped).toEqual([
      { path: ".claude/settings.json", reason: "not_allowed" },
      { path: ".mcp.json", reason: "not_allowed" },
      { path: "CLAUDE.local.md", reason: "not_allowed" },
      { path: ".claude/agents/x.md", reason: "not_allowed" },
      { path: "notes.txt", reason: "not_allowed" },
    ]);
  });

  it("stops at import depth 5", async () => {
    const files: Record<string, string> = { "CLAUDE.md": "@d1.md" };
    for (let i = 1; i <= 7; i++) files[`d${i}.md`] = `@d${i + 1}.md`;
    expect(paths(await buildClaudeContext(await repo(files), { skills: false }))).toEqual([
      "CLAUDE.md",
      "d1.md",
      "d2.md",
      "d3.md",
      "d4.md",
      "d5.md",
    ]);
  });

  it("reads a file reached by two imports once, and ignores missing imports", async () => {
    const root = await repo({
      "CLAUDE.md": "@a.md @b.md @missing.md",
      "a.md": "@shared.md",
      "b.md": "@shared.md",
      "shared.md": "s",
    });
    const ctx = await buildClaudeContext(root, { skills: false });
    expect(paths(ctx)).toEqual(["CLAUDE.md", "a.md", "b.md", "shared.md"]);
    expect(ctx.skipped).toEqual([]);
  });

  it("includes only SKILL.md per skill, and only when skills are on", async () => {
    const root = await repo({
      ".claude/skills/beta/SKILL.md": "b",
      ".claude/skills/alpha/SKILL.md": "a",
      ".claude/skills/alpha/scripts/run.sh": "echo",
      ".claude/settings.json": "{}",
      ".mcp.json": "{}",
    });
    expect(paths(await buildClaudeContext(root, { skills: true }))).toEqual([
      ".claude/skills/alpha/SKILL.md",
      ".claude/skills/beta/SKILL.md",
    ]);
    expect(paths(await buildClaudeContext(root, { skills: false }))).toEqual([]);
  });

  it("refuses symlinked files and symlinked directories", async () => {
    const root = await repo({ "real.md": "secret", "docs/x.md": "x" });
    await symlink(join(root, "real.md"), join(root, "CLAUDE.md"));
    await mkdir(join(root, ".claude"), { recursive: true });
    await symlink(join(root, "docs"), join(root, ".claude", "skills"));
    const ctx = await buildClaudeContext(root, { skills: true });
    expect(ctx.files).toEqual([]);
    expect(ctx.skipped).toContainEqual({ path: "CLAUDE.md", reason: "symlink" });
  });

  it("refuses an import through a symlinked parent directory and a symlinked skill directory", async () => {
    const outside = await repo({ "secret.md": "secret", "SKILL.md": "outside skill" });
    const root = await repo({ "CLAUDE.md": "@linked/secret.md", ".claude/skills/real/SKILL.md": "r" });
    await symlink(outside, join(root, "linked"));
    await symlink(outside, join(root, ".claude", "skills", "evil"));
    const ctx = await buildClaudeContext(root, { skills: true });
    expect(paths(ctx)).toEqual(["CLAUDE.md", ".claude/skills/real/SKILL.md"]);
    expect(ctx.skipped).toEqual([
      { path: "linked/secret.md", reason: "symlink" },
      { path: ".claude/skills/evil/SKILL.md", reason: "symlink" },
    ]);
  });

  it("skips a directory where a file was expected", async () => {
    const root = await repo({ "CLAUDE.md": "@docs.md", "docs.md/x.md": "x" });
    const ctx = await buildClaudeContext(root, { skills: false });
    expect(ctx.skipped).toEqual([{ path: "docs.md", reason: "not_file" }]);
  });

  it("skips oversized and non-UTF-8 files", async () => {
    const root = await repo({
      "CLAUDE.md": "@big.md @bin.md",
      "big.md": "x".repeat(CLAUDE_CONTEXT_LIMITS.maxFileBytes + 1),
    });
    await writeFile(join(root, "bin.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const ctx = await buildClaudeContext(root, { skills: false });
    expect(paths(ctx)).toEqual(["CLAUDE.md"]);
    expect(ctx.skipped).toEqual([
      { path: "big.md", reason: "too_large" },
      { path: "bin.md", reason: "not_utf8" },
    ]);
  });

  it("enforces the total size budget", async () => {
    const chunk = "x".repeat(60 * 1024);
    const files: Record<string, string> = { "CLAUDE.md": "@a.md @b.md @c.md @d.md @e.md" };
    for (const n of ["a", "b", "c", "d", "e"]) files[`${n}.md`] = chunk;
    const ctx = await buildClaudeContext(await repo(files), { skills: false });
    const total = ctx.files.reduce((s, f) => s + Buffer.byteLength(f.content), 0);
    expect(total).toBeLessThanOrEqual(CLAUDE_CONTEXT_LIMITS.maxTotalBytes);
    expect(ctx.skipped.some((s) => s.reason === "limit")).toBe(true);
  });

  it("records every candidate after the limit as limit, even ones that would fit", async () => {
    const chunk = "x".repeat(60 * 1024);
    const files: Record<string, string> = { "CLAUDE.md": "@a.md @b.md @c.md @d.md @e.md @tiny.md", "tiny.md": "t" };
    for (const n of ["a", "b", "c", "d", "e"]) files[`${n}.md`] = chunk;
    const ctx = await buildClaudeContext(await repo(files), { skills: false });
    expect(paths(ctx)).toEqual(["CLAUDE.md", "a.md", "b.md", "c.md", "d.md"]);
    expect(ctx.skipped).toEqual([
      { path: "e.md", reason: "limit" },
      { path: "tiny.md", reason: "limit" },
    ]);
  });

  it("enforces the file-count limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < CLAUDE_CONTEXT_LIMITS.maxFiles + 2; i++)
      files[`.claude/skills/s${String(i).padStart(3, "0")}/SKILL.md`] = "s";
    const ctx = await buildClaudeContext(await repo(files), { skills: true });
    expect(ctx.files).toHaveLength(CLAUDE_CONTEXT_LIMITS.maxFiles);
    expect(ctx.skipped).toEqual([
      { path: ".claude/skills/s200/SKILL.md", reason: "limit" },
      { path: ".claude/skills/s201/SKILL.md", reason: "limit" },
    ]);
  });

  it("caps recorded skips and counts the rest", async () => {
    const imports = Array.from({ length: 80 }, (_, i) => `@/abs${i}`).join(" ");
    const ctx = await buildClaudeContext(await repo({ "CLAUDE.md": imports }), { skills: false });
    expect(ctx.skipped).toHaveLength(MAX_RECORDED_SKIPS);
    expect(ctx.skipped[0]).toEqual({ path: "/abs0", reason: "outside_repo" });
    expect(ctx.skippedOverflow).toBe(80 - MAX_RECORDED_SKIPS);
  });

  it("considers only the first imports of each file and counts the rest", async () => {
    const extra = 7;
    const names = Array.from({ length: MAX_IMPORTS_PER_FILE + extra }, (_, i) => `i${i}.md`);
    const files: Record<string, string> = { "CLAUDE.md": names.map((n) => `@${n}`).join(" ") };
    for (const n of names) files[n] = "x";
    const ctx = await buildClaudeContext(await repo(files), { skills: false });
    expect(paths(ctx)).toEqual(["CLAUDE.md", ...names.slice(0, MAX_IMPORTS_PER_FILE)]);
    expect(ctx.skipped).toEqual([]);
    expect(ctx.skippedOverflow).toBe(extra);
  });

  it("reports candidates after the limit as limit without inspecting them", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < CLAUDE_CONTEXT_LIMITS.maxFiles; i++)
      files[`.claude/skills/s${String(i).padStart(3, "0")}/SKILL.md`] = "s";
    files[".claude/skills/s200/SKILL.md"] = "fits but over the count";
    const root = await repo(files);
    // A symlinked skill after the limit would be reported as "symlink" if it were still inspected.
    await mkdir(join(root, ".claude", "skills", "s201"));
    await symlink(join(root, "CLAUDE.md"), join(root, ".claude", "skills", "s201", "SKILL.md"));
    const ctx = await buildClaudeContext(root, { skills: true });
    expect(ctx.files).toHaveLength(CLAUDE_CONTEXT_LIMITS.maxFiles);
    expect(ctx.skipped).toEqual([
      { path: ".claude/skills/s200/SKILL.md", reason: "limit" },
      { path: ".claude/skills/s201/SKILL.md", reason: "limit" },
    ]);
  });

  it("considers at most MAX_SKILL_ENTRIES skills directory entries and counts that more were left", async () => {
    const root = await repo({});
    const skills = join(root, ".claude", "skills");
    await mkdir(skills, { recursive: true });
    // Empty skill directories: each one considered costs an inspect but loads nothing.
    for (let i = 0; i < MAX_SKILL_ENTRIES + 3; i++) await mkdir(join(skills, `s${i}`));
    const ctx = await buildClaudeContext(root, { skills: true });
    expect(ctx.files).toEqual([]);
    expect(ctx.skipped).toEqual([]);
    expect(ctx.skippedOverflow).toBe(1);
  });
});
