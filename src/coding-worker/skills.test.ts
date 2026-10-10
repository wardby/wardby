import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("ignores a symlinked skills root", async () => {
    const root = await repo({ "elsewhere/x/SKILL.md": "---\nname: x\n---\n" });
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink(join(root, "elsewhere"), join(root, ".agents", "skills"));
    expect(await repoSkillNames(root)).toEqual([]);
  });

  it("disables only the built-ins when repo skills are on, and everything when off", async () => {
    const root = await repo({ ".agents/skills/a/SKILL.md": "---\nname: alpha\n---\n" });
    expect(await disabledCodexSkills(root, true)).toEqual([...CODEX_BUILTIN_SKILLS]);
    expect(await disabledCodexSkills(root, false)).toEqual(["alpha", ...CODEX_BUILTIN_SKILLS].sort());
  });
});
