/**
 * Protected for every coding run, whatever an agent's own protectedPaths say
 * (docs/coding-services.md): wardby's own configuration under .wardby/, except
 * the service declaration, which any builder may propose in its pull request
 * (it takes effect only after a person merges it, since dispatch reads it from
 * the base branch). Part of DEFAULT_PROTECTED_PATHS so new agents show it, and
 * always added by protectedPathMatcher (providers/vcs/git.ts) so agents created
 * before it existed get it too. The matcher applies it ahead of the agent's own
 * list: the declaration is never protected, and nothing else under .wardby/ can
 * be unprotected by an agent's exceptions.
 */
export const WARDBY_PROTECTED_PATHS = [".wardby/**", "!.wardby/services.yaml"] as const;

/**
 * Added to a workflow run's protected paths at dispatch (#582): the run may not change Claude Code's
 * repository configuration, its workflow scripts included, so a workflow can't rewrite itself or
 * another workflow in its pull request.
 */
export const WORKFLOW_PROTECTED_PATHS = [".claude/**"] as const;

/** A run's protected paths: the agent's, plus WORKFLOW_PROTECTED_PATHS on a workflow run. */
export function runProtectedPaths(agentPaths: readonly string[], workflow: boolean): string[] {
  return workflow ? [...new Set([...agentPaths, ...WORKFLOW_PROTECTED_PATHS])] : [...agentPaths];
}

/**
 * A leading "!" makes a protectedPaths entry an exception (providers/vcs/git.ts
 * protectedPathMatcher): one literal file path carved out of the agent's own
 * patterns. Exceptions take no wildcards, so "!**" or "!.github/**" cannot
 * switch a whole protected tree off.
 */
export const PROTECTED_PATH_EXCEPTION = "!";

export function isProtectedPathException(path: string): boolean {
  return path.startsWith(PROTECTED_PATH_EXCEPTION);
}

/** The glob of a protectedPaths entry: the entry itself, or what follows an exception's leading "!". */
export function protectedPathBody(path: string): string {
  return isProtectedPathException(path) ? path.slice(PROTECTED_PATH_EXCEPTION.length) : path;
}

/** Glob metacharacters an exception may not contain: it names one literal file. */
const EXCEPTION_GLOB_CHARACTERS = /[*?[\]{}]/;

/**
 * Whether a trimmed protectedPaths entry has a valid shape: a repository-relative
 * POSIX glob with no empty or traversal components, or, behind one leading "!",
 * such a path with no glob metacharacters. Length and control-character bounds
 * are the caller's.
 */
export function isWellFormedProtectedPath(path: string): boolean {
  const body = protectedPathBody(path);
  return (
    body.length > 0 &&
    !isProtectedPathException(body) &&
    !(isProtectedPathException(path) && EXCEPTION_GLOB_CHARACTERS.test(body)) &&
    !body.startsWith("/") &&
    !body.startsWith("./") &&
    !body.includes("\\") &&
    !body.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

/** Exceptions only carve paths out; a list of nothing but exceptions protects nothing. */
export function protectsSomePath(paths: readonly string[]): boolean {
  return paths.some((path) => !isProtectedPathException(path));
}
