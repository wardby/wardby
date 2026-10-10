import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_BUILTIN_SKILLS, disabledCodexSkills, repoSkillNames } from "./skills.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))));
async function repo(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "wardby-codex-skills-"));
  roots.push(root);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

describe("Codex repo skills", () => {
  it("names skills from frontmatter, falling back to the directory", async () => {
    const root = await repo({
      ".agents/skills/a/SKILL.md": "---\nname: alpha\ndescription: x\n---\n",
      ".codex/skills/b/SKILL.md": "no frontmatter",
      ".claude/skills/c/SKILL.md": "---\nname: ignored\n---\n",
    });
    expect(await repoSkillNames(root)).toEqual(["alpha", "b"]);
  });

  it("falls back to the directory for an empty or whitespace-only name, never the next line", async () => {
    const root = await repo({
      ".agents/skills/empty/SKILL.md": "---\nname:\ndescription: not-a-name\n---\n",
      ".agents/skills/blank/SKILL.md": "---\nname:   \ndescription: also-not\n---\n",
    });
    expect(await repoSkillNames(root)).toEqual(["blank", "empty"]);
  });

  it("ignores a symlinked skills root", async () => {
    const root = await repo({ "elsewhere/x/SKILL.md": "---\nname: x\n---\n" });
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink(join(root, "elsewhere"), join(root, ".agents", "skills"));
    expect(await repoSkillNames(root)).toEqual([]);
  });

  it("never reads a symlinked or oversized SKILL.md", async () => {
    const root = await repo({
      "elsewhere/SKILL.md": "---\nname: linked\n---\n",
      ".agents/skills/big/SKILL.md": `---\nname: big\n---\n${"x".repeat(64 * 1024)}`,
      ".agents/skills/ok/SKILL.md": "---\nname: ok\n---\n",
    });
    await mkdir(join(root, ".agents", "skills", "link"), { recursive: true });
    await symlink(join(root, "elsewhere", "SKILL.md"), join(root, ".agents", "skills", "link", "SKILL.md"));
    expect(await repoSkillNames(root)).toEqual(["ok"]);
  });

  it("disables only the built-ins when repo skills are on, and everything when off", async () => {
    const root = await repo({ ".agents/skills/a/SKILL.md": "---\nname: alpha\n---\n" });
    expect(await disabledCodexSkills(root, true)).toEqual([...CODEX_BUILTIN_SKILLS]);
    expect(await disabledCodexSkills(root, false)).toEqual(["alpha", ...CODEX_BUILTIN_SKILLS].sort());
  });

  it("caps the total entries scanned across both roots instead of an unbounded walk, and warns once", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-codex-skills-"));
    roots.push(root);
    const skillsDir = join(root, ".agents", "skills");
    await mkdir(skillsDir, { recursive: true });
    for (let i = 0; i < 10; i++) await mkdir(join(skillsDir, `skill-${i}`), { recursive: true });
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await expect(repoSkillNames(root, 3)).resolves.toEqual([]);
    } finally {
      stderr.mockRestore();
    }
    expect(writes.filter((line) => line.includes("codex_skill_scan_truncated"))).toHaveLength(1);
  });
});
