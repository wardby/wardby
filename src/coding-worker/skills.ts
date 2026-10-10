// Which Codex skills the worker tells the pinned CLI to disable
// (skills.config, mapped to one { name, enabled: false } entry per name in
// sdk.ts). Codex ships a handful of built-in skills from its own installed
// home directory; this worker never wants those offered to the model. When
// the run also turns off the repository's own skills (CodingTaskInput.repoSkills
// === false), every skill the repo defines under .agents/skills/ or
// .codex/skills/ is disabled too.
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Codex's own built-in skills, loaded from its installed home directory regardless of workspace. */
export const CODEX_BUILTIN_SKILLS = ["imagegen", "openai-docs", "skill-creator", "skill-installer"] as const;

const REPO_SKILL_ROOTS = [".agents/skills", ".codex/skills"];
const MAX_SKILL_WALK_DEPTH = 3;
const MAX_SKILL_MD_BYTES = 64 * 1024;

/** First `---`-delimited frontmatter block's `name:` value, quotes trimmed. */
function frontmatterName(content: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!frontmatter) return null;
  const name = /^name:\s*(.+)$/m.exec(frontmatter[1]);
  if (!name) return null;
  return name[1].trim().replace(/^["']|["']$/g, "");
}

async function skillNameFromFile(skillMdPath: string): Promise<string | null> {
  let stats;
  try {
    stats = await lstat(skillMdPath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > MAX_SKILL_MD_BYTES) return null;
  let content: string;
  try {
    content = await readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }
  return frontmatterName(content) ?? basename(dirname(skillMdPath));
}

async function walkSkillRoot(dir: string, depth: number, names: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      const name = await skillNameFromFile(entryPath);
      if (name) names.add(name);
    } else if (entry.isDirectory() && depth < MAX_SKILL_WALK_DEPTH) {
      // Dirent.isDirectory() reflects the directory-entry type from readdir itself
      // (not a followed stat), so a symlinked subdirectory reports false here and
      // is skipped without ever being opened.
      await walkSkillRoot(entryPath, depth + 1, names);
    }
  }
}

/** The repository's own Codex skill names, from `.agents/skills/` and `.codex/skills/` under `workspace`. */
export async function repoSkillNames(workspace: string): Promise<string[]> {
  const names = new Set<string>();
  for (const root of REPO_SKILL_ROOTS) {
    const rootPath = join(workspace, root);
    let stats;
    try {
      stats = await lstat(rootPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    await walkSkillRoot(rootPath, 0, names);
  }
  return [...names].sort();
}

/**
 * Codex skills to disable by name (skills.config): always the built-ins, plus
 * every repo skill when `repoSkills` is false.
 */
export async function disabledCodexSkills(workspace: string, repoSkills: boolean): Promise<string[]> {
  if (repoSkills) return [...CODEX_BUILTIN_SKILLS];
  const repoNames = await repoSkillNames(workspace);
  return [...new Set([...CODEX_BUILTIN_SKILLS, ...repoNames])].sort();
}
