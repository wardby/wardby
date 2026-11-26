import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the agent (its shells share the CLI's uid and HOME) can write under HOME that the CLI loads
 * at its next start and that could relax the run's lock-down: user policies (they outrank per-run
 * tool exclusions), extensions, user agents, skills and commands, trusted folders, the global
 * context files (GEMINI.md, AGENTS.md, CLAUDE.md under ~/.gemini), the agent acknowledgments (they
 * register project agents in headless mode), ~/.agents skills, and ~/.env (0.70.0 Storage paths).
 * Also, as defence in depth, ~/.gemini/.env and the MCP and A2A OAuth token files. Relative to HOME.
 * Each project's memory (~/.gemini/tmp/<project>/memory) goes too (resetGeminiAgentState).
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
  ".gemini/AGENTS.md",
  ".gemini/CLAUDE.md",
  ".gemini/acknowledgments",
  ".gemini/.env",
  ".gemini/mcp-oauth-tokens.json",
  ".gemini/a2a-oauth-tokens.json",
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
 * Removes GEMINI_AGENT_WRITABLE_PATHS and every project memory before each CLI start (the first turn and the repair turn).
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
  if (gemini) await removeProjectMemory(join(home, ".gemini", "tmp"));
}

/**
 * Every project's memory under ~/.gemini/tmp, the session store beside it kept. Each entry is
 * checked with lstat and never followed: a link is removed itself (its session, if it had one, goes
 * with it and the repair fails closed); a regular file is left as it is.
 */
async function removeProjectMemory(tmp: string): Promise<void> {
  const stats = await lstat(tmp).catch(() => undefined);
  if (stats?.isSymbolicLink()) await rm(tmp, { force: true });
  if (!stats?.isDirectory()) return;
  for (const entry of await readdir(tmp)) {
    const path = join(tmp, entry);
    const entryStats = await lstat(path).catch(() => undefined);
    if (entryStats?.isSymbolicLink()) await rm(path, { force: true });
    else if (entryStats?.isDirectory()) await rm(join(path, "memory"), { recursive: true, force: true });
  }
}
