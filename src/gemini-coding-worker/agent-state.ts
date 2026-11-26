import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the agent (its shells share the CLI's uid and HOME) can write under HOME that the CLI loads
 * at its next start and that could relax the run's lock-down: user policies (they outrank per-run
 * tool exclusions), extensions, user agents, skills and commands, trusted folders, the global
 * GEMINI.md, ~/.agents skills, and ~/.env (0.70.0 Storage paths). Relative to HOME.
 *
 * Kept: the CLI's session store, which `--resume latest` needs (~/.gemini/tmp/<project>/chats,
 * ~/.gemini/projects.json, ~/.gemini/history). settings.json is rewritten whole by
 * writeGeminiUserSettings.
 */
export const GEMINI_AGENT_WRITABLE_PATHS = [
  ".gemini/policies",
  ".gemini/extensions",
  ".gemini/agents",
  ".gemini/skills",
  ".gemini/commands",
  ".gemini/trustedFolders.json",
  ".gemini/GEMINI.md",
  ".agents/skills",
  ".env",
] as const;

/** A directory the reset descends into: anything else in its place (a link included) is removed, never followed. */
async function realDirectoryOrGone(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => undefined);
  if (!stats) return false;
  if (stats.isDirectory()) return true;
  await rm(path, { force: true });
  return false;
}

/**
 * Removes GEMINI_AGENT_WRITABLE_PATHS before each CLI start (the first turn and the repair turn).
 * Never follows a link: a ~/.gemini or ~/.agents that is not a real directory is removed itself
 * (the session store goes with a linked ~/.gemini; the repair then finds no session and fails
 * closed). rm does not follow a link given as its own path.
 */
export async function resetGeminiAgentState(home: string): Promise<void> {
  const gemini = await realDirectoryOrGone(join(home, ".gemini"));
  const agents = await realDirectoryOrGone(join(home, ".agents"));
  for (const path of GEMINI_AGENT_WRITABLE_PATHS) {
    if (path.startsWith(".gemini/") && !gemini) continue;
    if (path.startsWith(".agents/") && !agents) continue;
    await rm(join(home, path), { recursive: true, force: true });
  }
}
