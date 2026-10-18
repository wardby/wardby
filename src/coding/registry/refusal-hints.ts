/**
 * Shared wording for package refusals served by the registry proxy. Pure (no provider imports) so the
 * proxy, the run report, and the PR banner all read one table.
 */

export const PACKAGE_NOT_ALLOWED = "wardby_package_not_allowed";
export const PACKAGE_NOT_ALLOWED_PENDING = "wardby_package_not_allowed_pending";
export const GRAPH_LIMIT = "wardby_graph_limit";
export const GRAPH_INCOMPLETE = "wardby_graph_incomplete";

export interface WalkProgress {
  walked: number;
  queued: number;
}

function packages(count: number): string {
  return `${count.toLocaleString("en-US")} package${count === 1 ? "" : "s"}`;
}

export function notAllowedMessage(name: string, ecosystem: string, hasAllowlist: boolean): string {
  const why = hasAllowlist
    ? `${name} (${ecosystem}) is not on this agent's allowlist, and no allowlisted package this run resolved depends on it (a package added to the project directly must itself be allowlisted)`
    : `${name} (${ecosystem}) is not allowed: this agent has no allowlist for ${ecosystem}`;
  return `${why}. The agent's owner must allowlist it; retrying will not help.`;
}

export function notAllowedPendingMessage(name: string, ecosystem: string, progress: WalkProgress): string {
  return (
    `${name} (${ecosystem}) is not on this agent's allowlist, and was not found among the allowlisted packages' dependencies after ` +
    `${packages(progress.walked)}, at least ${progress.queued.toLocaleString("en-US")} more queued. ` +
    `It may still be reachable, but the walk was cut short; retrying rarely helps. ` +
    `The agent's owner must allowlist ${name} directly.`
  );
}

export function graphLimitMessage(name: string, ecosystem: string, limit: number): string {
  return (
    `${name} (${ecosystem}) wasn't reached before this run's dependency graph walk hit its limit of ${packages(limit)} ` +
    `(REGISTRY_MAX_GRAPH_PACKAGES); retrying will not help. ` +
    `The agent's owner must allowlist ${name} directly, or the operator can raise the limit.`
  );
}

export function graphIncompleteMessage(name: string, ecosystem: string, progress: WalkProgress): string {
  return (
    `${name} (${ecosystem}) is still being checked against the allowed packages' dependency graph after ${packages(progress.walked)}, ` +
    `${progress.queued.toLocaleString("en-US")} still queued; the walk timed out before checking it (usually a slow upstream for that package, or another request's walk running out of time). Please try again shortly.`
  );
}

const OWNER = "The agent's owner must allowlist the package directly; retrying will not help.";

const HINTS: Record<string, string> = {
  [PACKAGE_NOT_ALLOWED]: `The package is not on the agent's allowlist and no allowlisted package the run resolved depends on it. ${OWNER}`,
  [PACKAGE_NOT_ALLOWED_PENDING]: `The dependency walk ended before reaching the package. Retrying rarely helps. ${OWNER}`,
  [GRAPH_LIMIT]: `The run's dependency graph walk hit REGISTRY_MAX_GRAPH_PACKAGES before reaching the package, so it may not be in the graph at all. Retrying will not help. The agent's owner must allowlist the package directly, or the operator can raise the limit.`,
  [GRAPH_INCOMPLETE]:
    "The walk reached the package but timed out before checking its versions, usually a slow upstream. Try again shortly.",
  wardby_version_filtered:
    "Every version the agent may use is newer than the release-age limit, outside the allowlisted range, or has a blocking advisory. Pin an older version, or the agent's owner can change the allowlist or policy.",
  wardby_file_not_allowed:
    "The registry serves wheels only, and the allowed versions of this package publish only source distributions. Use a version or package that ships a wheel, or ask the agent's owner.",
};

/** What each refusal code means to someone reading the PR, without the registry's internals. */
const MEANINGS: Record<string, string> = {
  [PACKAGE_NOT_ALLOWED]:
    "not on the allowlist, or only reachable through a refused package; the owner must allowlist it",
  [PACKAGE_NOT_ALLOWED_PENDING]: "not reached before the dependency walk stopped; the owner must allowlist it",
  [GRAPH_LIMIT]:
    "not reached before the run's dependency graph walk hit its package limit; the owner must allowlist it directly",
  [GRAPH_INCOMPLETE]: "still being checked against the allowed packages' dependency graph; retry shortly",
  wardby_version_filtered: "withheld: newer than the release-age limit, or a high-severity advisory",
  wardby_file_not_allowed: "no wheel to install: only source distributions, which the registry does not serve",
  wardby_lockfile_integrity_mismatch: "the lock file's integrity does not match the registry's",
  wardby_upstream_error: "the upstream registry failed (transient)",
  wardby_audit_unavailable: "the advisory check was unavailable (transient)",
};

/** Static guidance for a stored refusal code (get_run `hint`); undefined for unknown codes. */
export function refusalHint(code: string): string | undefined {
  return Object.hasOwn(HINTS, code) ? HINTS[code] : undefined;
}

/** Short parenthetical for the PR banner; undefined for unknown codes. */
export function refusalMeaning(code: string): string | undefined {
  return Object.hasOwn(MEANINGS, code) ? MEANINGS[code] : undefined;
}
