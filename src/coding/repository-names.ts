/** Control-plane only (protocol.ts ships in worker images). See #537. */
import { LOCAL_REPO_PREFIX } from "./protocol.js";

/** The name a coding link gets when none is given: the repository's short name, lower-cased. Never suffixed. */
export function defaultRepositoryName(repository: string): string {
  const path = repository.startsWith(LOCAL_REPO_PREFIX) ? repository.slice(LOCAL_REPO_PREFIX.length) : repository;
  const parts = path.split("/").filter(Boolean);
  return (parts.at(-1) ?? "").toLowerCase();
}
