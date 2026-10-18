/**
 * What a host (a builder continuation comment, a mention status comment) is
 * told when a coding run's changes touched a path this agent may not edit
 * (protectedPathMatcher in src/providers/vcs/git.ts). Public repositories
 * read these, so the path -- taken from the run's own diff -- is treated as
 * untrusted text: it never carries a backtick, a control character, or more
 * than MAX_PATH_CHARS.
 */

/** CodingRun.failureCategory for a run whose collected changes touched a protected path. */
export const PROTECTED_PATH_CATEGORY = "protected_path";

/** git.ts's finalizeChanges throws this when the collected diff touches a protected path. */
const PROTECTED_PATH_ERROR_PREFIX = "vcs_protected_path:";

/** The path a `vcs_protected_path:<path>` error names, or null for any other error. */
export function protectedPathFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message.startsWith(PROTECTED_PATH_ERROR_PREFIX)) return null;
  const path = message.slice(PROTECTED_PATH_ERROR_PREFIX.length);
  return path.length > 0 ? path : null;
}

const MAX_PATH_CHARS = 200;

/**
 * A single-line, backtick-free rendering of a repository path safe to drop
 * into one Markdown code span: control characters and backticks (which would
 * otherwise close the span early) are neutralised, runs of whitespace
 * collapse to one line, and the result is capped with an ellipsis. Null when
 * nothing usable is left.
 */
export function sanitizePath(path: string): string | null {
  // eslint-disable-next-line no-control-regex -- deliberately stripping C0/DEL control characters.
  const withoutControls = path.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const oneLine = withoutControls.replace(/\s+/g, " ").trim();
  const withoutBackticks = oneLine.replace(/`/g, "'");
  if (withoutBackticks.length === 0) return null;
  return withoutBackticks.length > MAX_PATH_CHARS ? `${withoutBackticks.slice(0, MAX_PATH_CHARS)}…` : withoutBackticks;
}

/**
 * The host sentence for a run stopped because its changes touched a
 * protected path. Named the file when `path` sanitises to something usable;
 * otherwise falls back to a sentence that doesn't try to name it.
 */
export function protectedPathSentence(path: string | null | undefined): string {
  const safe = path ? sanitizePath(path) : null;
  const named = safe
    ? `its changes include \`${safe}\`, which this agent may not edit`
    : "its changes include a file this agent may not edit";
  return `${named}, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.`;
}

/**
 * The fixed line for a mention status comment naming a failed protected_path
 * sub-run (host-status.ts). That comment reads children from the database,
 * which has no path -- only the category -- so this line never names a file.
 */
export const PROTECTED_PATH_HOST_LINE =
  "A sub-run could not open its changes: it changed a file its agent may not edit, so none of its changes were kept.";
