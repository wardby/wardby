// Which Codex skills the worker tells the pinned CLI to disable
// (skills.config, mapped to one { name, enabled: false } entry per name in
// sdk.ts). Codex ships a handful of built-in skills from its own installed
// home directory; this worker never wants those offered to the model. When
// the run also turns off the repository's own skills (CodingTaskInput.repoSkills
// === false), every skill the repo defines under .agents/skills/ or
// .codex/skills/ is disabled too.
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readBoundedRegularFile } from "./artifact.js";

/** Codex's own built-in skills, loaded from its installed home directory regardless of workspace. */
export const CODEX_BUILTIN_SKILLS = ["imagegen", "openai-docs", "skill-creator", "skill-installer"] as const;

const REPO_SKILL_ROOTS = [".agents/skills", ".codex/skills"];
const MAX_SKILL_WALK_DEPTH = 3;
const MAX_SKILL_MD_BYTES = 64 * 1024;

/**
 * Upper bound on how many directory entries `repoSkillNames` will visit across both
 * roots in one call. The repository's skill roots are untrusted content: without a
 * breadth cap, a directory with huge fan-out would drive unbounded readdir/lstat/
 * readFile work. When the cap is hit, scanning stops early and the names found so
 * far are returned -- never a thrown error.
 */
export const MAX_SKILL_SCAN_ENTRIES = 2000;

interface SkillScanBudget {
  remaining: number;
  truncated: boolean;
}

/** First `---`-delimited frontmatter block's `name:` value, quotes trimmed. */
function frontmatterName(content: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!frontmatter) return null;
  // [ \t]*, not \s*: an empty `name:` must not capture the next line.
  const name = /^name:[ \t]*(.+)$/m.exec(frontmatter[1]);
  if (!name) return null;
  return name[1].trim().replace(/^["']|["']$/g, "");
}

async function skillNameFromFile(skillMdPath: string): Promise<string | null> {
  let content: string;
  try {
    // Checks what was actually opened (no symlink, a regular file, within the size bound) on the
    // open descriptor, so the file can't be swapped between the check and the read.
    content = await readBoundedRegularFile(skillMdPath, MAX_SKILL_MD_BYTES, "codex_skill_file_invalid");
  } catch {
    return null;
  }
  // || so an empty or whitespace-only name also falls back to the directory.
  return frontmatterName(content) || basename(dirname(skillMdPath));
}

async function walkSkillRoot(dir: string, depth: number, names: Set<string>, budget: SkillScanBudget): Promise<void> {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      return;
    }
    budget.remaining -= 1;
    const entryPath = join(dir, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      const name = await skillNameFromFile(entryPath);
      if (name) names.add(name);
    } else if (entry.isDirectory() && depth < MAX_SKILL_WALK_DEPTH) {
      // Dirent.isDirectory() reflects the directory-entry type from readdir itself
      // (not a followed stat), so a symlinked subdirectory reports false here and
      // is skipped without ever being opened.
      await walkSkillRoot(entryPath, depth + 1, names, budget);
    }
  }
}

/**
 * The repository's own Codex skill names, from `.agents/skills/` and `.codex/skills/`
 * under `workspace`. Stops scanning once `maxEntries` directory entries have been
 * visited across both roots combined (default `MAX_SKILL_SCAN_ENTRIES`; a test-only
 * override), returning the names found so far and writing one JSON warning line to
 * stderr -- it never throws because of a large or adversarial skills tree.
 */
export async function repoSkillNames(
  workspace: string,
  maxEntries: number = MAX_SKILL_SCAN_ENTRIES,
): Promise<string[]> {
  const names = new Set<string>();
  const budget: SkillScanBudget = { remaining: maxEntries, truncated: false };
  for (const root of REPO_SKILL_ROOTS) {
    const rootPath = join(workspace, root);
    let stats;
    try {
      stats = await lstat(rootPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    await walkSkillRoot(rootPath, 0, names, budget);
  }
  if (budget.truncated) {
    process.stderr.write(`${JSON.stringify({ warning: "codex_skill_scan_truncated" })}\n`);
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
