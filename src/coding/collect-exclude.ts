/**
 * Paths a coding run's workspace never sends back: dependency and cache folders
 * (matched by name at any depth) plus per-agent repository-relative paths. The
 * same set is rendered four ways so the Kubernetes keeper's tar, the Docker
 * staging prune (isCollectExcluded), Git staging, and a history run's worker
 * `.git/info/exclude` all agree on what "excluded" means.
 */
export const BUILTIN_COLLECT_EXCLUDE_NAMES = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  ".vite",
  ".cache",
] as const;

export const MAX_COLLECT_EXCLUDE_PATHS = 64;
const MAX_PATH_BYTES = 512;
const CONTROL = /[\u0000-\u001F\u007F]/;
const GLOB = /[*?[\]]/;

export interface CollectExclusions {
  names: readonly string[];
  paths: readonly string[];
}

export function validateCollectExcludePath(value: string): string {
  const path = value.trim();
  const valid =
    path.length > 0 &&
    Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES &&
    !CONTROL.test(path) &&
    !GLOB.test(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.startsWith("./") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
  if (!valid) throw new Error("collect_exclude_path_invalid");
  return path;
}

export function collectExclusions(paths: readonly string[]): CollectExclusions {
  if (paths.length > MAX_COLLECT_EXCLUDE_PATHS) throw new Error("collect_exclude_path_invalid");
  return { names: [...BUILTIN_COLLECT_EXCLUDE_NAMES], paths: [...new Set(paths.map(validateCollectExcludePath))] };
}

/** For values read back from the database or a job record, which are untrusted shapes. */
export function normalizeCollectExclusions(value: unknown): CollectExclusions {
  if (value === undefined || value === null) return collectExclusions([]);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("collect_exclude_invalid");
  }
  return collectExclusions(value);
}

export function isCollectExcluded(relativePath: string, exclusions: CollectExclusions): boolean {
  const segments = relativePath.split("/");
  if (segments.some((segment) => exclusions.names.includes(segment))) return true;
  return exclusions.paths.some((path) => relativePath === path || relativePath.startsWith(`${path}/`));
}

/**
 * GNU tar options for `tar -C <workspace> -cf - .`, whose member names start with
 * "./". Names are unanchored (they match any path component); paths are anchored
 * to the archive root. An excluded directory's contents are skipped with it.
 */
export function tarExcludeArgs(exclusions: CollectExclusions): string[] {
  return [
    "--no-anchored",
    ...exclusions.names.map((name) => `--exclude=${name}`),
    "--anchored",
    ...exclusions.paths.map((path) => `--exclude=./${path}`),
  ];
}

/** Git exclude pathspecs, appended after ":/" when staging. */
export function gitExcludePathspecs(exclusions: CollectExclusions): string[] {
  return [
    ...exclusions.names.flatMap((name) => [`:(exclude,glob)**/${name}`, `:(exclude,glob)**/${name}/**`]),
    ...exclusions.paths.map((path) => `:(exclude,literal)${path}`),
  ];
}

/**
 * A history run's worker `.git/info/exclude` (#536), so that the agent's own `git add -A` never
 * stages what no run collects (the sandbox's npm config with the run's registry token lives under
 * `.cache`). Names have no slash, so they match at any depth; paths get a leading "/", which anchors
 * them to the repository root and keeps a leading "!" or "#" literal. validateCollectExcludePath has
 * already refused globs, backslashes, control characters and surrounding whitespace. This only steers
 * staging in the worker: files left uncommitted are still collected by the normal path, and
 * finalize still refuses any agent commit that touches an excluded path.
 */
export function gitInfoExcludeFile(exclusions: CollectExclusions): string {
  return [
    "# Paths a Wardby run never collects (dependency and cache folders, collectExclude).",
    ...exclusions.names,
    ...exclusions.paths.map((path) => `/${path}`),
    "",
  ].join("\n");
}
