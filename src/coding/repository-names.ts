/** Control-plane only (protocol.ts ships in worker images). See #537. */
import { LOCAL_REPO_PREFIX } from "./protocol.js";

/**
 * The name a coding link gets when none is given: the repository's short name, lower-cased and
 * repaired as the multi-repo migration repairs it (characters outside [a-z0-9._-] become "-",
 * leading non-alphanumerics dropped, cut to 59 characters, "repo" when nothing is left).
 * Never suffixed: a clash is refused, not renamed. "workspace" stays reserved and fails the
 * name check, so the caller must pass a name.
 */
export function defaultRepositoryName(repository: string): string {
  const path = repository.startsWith(LOCAL_REPO_PREFIX) ? repository.slice(LOCAL_REPO_PREFIX.length) : repository;
  const short = (path.split("/").filter(Boolean).at(-1) ?? "").toLowerCase();
  const repaired = short
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 59);
  return repaired || "repo";
}
