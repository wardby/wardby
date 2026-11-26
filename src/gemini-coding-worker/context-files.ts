import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { GEMINI_CONTEXT_FILE_NAMES } from "./cli.js";

/** The run's safe failure code for a repository context file the CLI must not read (errors.ts). */
export const CONTEXT_FILE_REFUSED = "coding_context_file_refused";

/** Entries the scan visits before it fails closed: far above a checkout plus its restored dependencies. */
export const MAX_CONTEXT_SCAN_ENTRIES = 1_000_000;

const NAMES: ReadonlySet<string> = new Set(GEMINI_CONTEXT_FILE_NAMES);

/**
 * Refuses the run when any entry named GEMINI.md, AGENTS.md or CLAUDE.md anywhere under the roots
 * (exact names, as 0.70.0 matches them on Linux) is not a regular file. The CLI follows symlinks
 * when it loads them: at start for the workspace root, and later for any subdirectory a tool touches
 * (its "JIT" memory). A committed `GEMINI.md -> /proc/self/environ` would put the CLI's environment,
 * the run capability included, into the system instruction. Claude Code's reader refuses symlinked
 * context files too (coding/claude-context.ts). The CLI's own @imports inside those files are
 * confined to the project root by real path, so a linked import is refused by the CLI itself.
 *
 * Run before each CLI start (the first turn and the repair). A symlink the agent creates mid-run is
 * shell trust (decision 13): its shells can already read /proc/self/environ.
 *
 * `roots` are every directory the CLI trusts: the workspace and each extra repository it is given
 * as an included directory (the CLI loads context files under each, at start and JIT; settings.ts).
 *
 * Never follows a link (Dirent types come from the directory listing, not stat), skips `.git`, and
 * fails closed past `maxEntries` (counted across all roots). A missing root has nothing to load.
 */
export async function assertGeminiContextFilesRegular(
  roots: string | readonly string[],
  options: { maxEntries?: number } = {},
): Promise<void> {
  const maxEntries = options.maxEntries ?? MAX_CONTEXT_SCAN_ENTRIES;
  const rootSet = new Set(typeof roots === "string" ? [roots] : roots);
  const pending = [...rootSet];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (rootSet.has(dir) && code === "ENOENT") continue;
      throw new Error(CONTEXT_FILE_REFUSED, { cause: error });
    }
    for await (const entry of handle) {
      if (++seen > maxEntries) throw new Error(CONTEXT_FILE_REFUSED);
      if (NAMES.has(entry.name) && !entry.isFile()) throw new Error(CONTEXT_FILE_REFUSED);
      if (entry.isDirectory() && entry.name !== ".git") pending.push(join(dir, entry.name));
    }
  }
}
