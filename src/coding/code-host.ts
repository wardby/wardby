/**
 * Which code host owns a repository, from the form of its id: `owner/name` is
 * GitHub, `local:/abs/path` a local folder, `<provider>:<workspace>/<repo>` a
 * registered host provider. Control-plane only: coding/protocol.ts ships in the
 * worker images, so this stays out of it.
 */
import { LOCAL_REPO_PREFIX, normalizeGitHubRepository } from "./protocol.js";

const HOSTED_REPOSITORY =
  /^([a-z][a-z0-9-]{1,30}):([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;
/** Never a registered provider: built-ins, and URL schemes a repository string could start with. */
const RESERVED_PREFIXES: ReadonlySet<string> = new Set(["github", "local", "http", "https", "ssh", "git", "file"]);

function hostedParts(value: string): { provider: string; workspace: string; repository: string } | null {
  const match = HOSTED_REPOSITORY.exec(value);
  if (!match || RESERVED_PREFIXES.has(match[1])) return null;
  const [, provider, workspace, repository] = match;
  return repository.endsWith(".") || workspace.endsWith(".") ? null : { provider, workspace, repository };
}

/** The provider that owns an already-normalized repository id. */
export function codeProviderOf(repository: string): string {
  if (repository.startsWith(LOCAL_REPO_PREFIX)) return "local";
  return hostedParts(repository)?.provider ?? "github";
}

/**
 * The canonical id of a repository on a host with pull requests: GitHub names,
 * or `<provider>:<workspace>/<repo>` lower-cased. Throws for anything else,
 * local repositories included, as normalizeGitHubRepository always has.
 */
export function normalizeHostedRepository(value: string): string {
  const hosted = hostedParts(value);
  if (hosted) return `${hosted.provider}:${hosted.workspace.toLowerCase()}/${hosted.repository.toLowerCase()}`;
  return normalizeGitHubRepository(value);
}

/**
 * A pull request's web link, known here only for GitHub. A GitHub name never
 * has a ":": anything that does gets no link, so no other host's id, valid or
 * not, reaches a github.com URL.
 */
export function pullRequestWebUrl(provider: string, repository: string, number: number): string | null {
  return provider === "github" && !repository.includes(":") ? `https://github.com/${repository}/pull/${number}` : null;
}
