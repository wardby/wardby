/**
 * The quickstart's `.wardby/services.yaml` handling for a local repository:
 * read the committed declaration on the default branch, or write a starter one
 * onto its own branch with git plumbing.
 *
 * The write never touches the user's working tree, index, or HEAD: it builds
 * the tree in a scratch index (GIT_INDEX_FILE in a temp dir), creates the
 * commit with commit-tree, and moves only refs/heads/wardby/quickstart-services
 * with a compare-and-swap update-ref. git runs through the hardened runner
 * (GIT_* stripped, hooks/fsmonitor off, no signing), with an explicit identity
 * so no user configuration is needed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localGit, localGitWrite } from "../coding/local-git.js";
import { LOCAL_REPO_PREFIX } from "../coding/local-repo.js";
import {
  MAX_SERVICE_DECLARATION_BYTES,
  SERVICE_DECLARATION_PATH,
  ServiceDeclarationError,
  declaredEntries,
  parseServiceDeclaration,
  type DeclaredService,
} from "../coding/services/declaration.js";
import { LocalRemote } from "../providers/vcs/local-remote.js";

export const STARTER_SERVICES_BRANCH = "wardby/quickstart-services";
const STARTER_REF = `refs/heads/${STARTER_SERVICES_BRANCH}`;
const COMMIT_MESSAGE = "Add starter .wardby/services.yaml (wardby quickstart)";
const IDENTITY = {
  GIT_AUTHOR_NAME: "wardby quickstart",
  GIT_AUTHOR_EMAIL: "quickstart@wardby.invalid",
  GIT_COMMITTER_NAME: "wardby quickstart",
  GIT_COMMITTER_EMAIL: "quickstart@wardby.invalid",
};
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type StarterService = "postgres" | "redis";

/** Catalog versions (src/coding/services/builtins.ts); the catalog pins each to an image digest. */
const STARTER_VERSIONS: Record<StarterService, string> = { postgres: "16", redis: "7" };

export function starterServicesYaml(choices: readonly StarterService[]): string {
  const lines = [
    "# Services wardby starts next to each coding run. Each name and version must",
    "# exist in the wardby service catalog, and the agent must allow the name",
    "# (codingProfile.services). See docs/coding-services.md.",
    "services:",
    ...[...new Set(choices)].sort().map((name) => `  ${name}: "${STARTER_VERSIONS[name]}"`),
  ];
  return `${lines.join("\n")}\n`;
}

/** `--starter-services postgres,redis|none`. */
export function parseStarterChoice(value: string): StarterService[] {
  const names = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 1 && names[0] === "none") return [];
  const chosen = new Set<StarterService>();
  for (const name of names) {
    if (name !== "postgres" && name !== "redis") {
      throw new Error(`--starter-services must list postgres, redis, or none; got "${value}".`);
    }
    chosen.add(name);
  }
  return [...chosen].sort();
}

/** The services a starter choice declares, as parseServiceDeclaration would read them back. */
export function starterDeclaredServices(choices: readonly StarterService[]): DeclaredService[] {
  return parseServiceDeclaration(starterServicesYaml(choices)).services;
}

/** The checked-out branch and its commit; null when HEAD is detached or the branch has no commits. */
export async function repoDefaultBranch(dir: string): Promise<{ branch: string; sha: string } | null> {
  let branch: string;
  try {
    branch = (await localGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], 64 * 1024)).trim();
  } catch {
    return null;
  }
  if (!branch) return null;
  try {
    const sha = (
      await localGit(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`])
    ).trim();
    return OBJECT_ID.test(sha) ? { branch, sha } : null;
  } catch {
    return null;
  }
}

export type DeclaredServicesStatus =
  | { kind: "absent" }
  /** `services`: every entry, the toolchain (also in `toolchain`) first. */
  | { kind: "valid"; services: DeclaredService[]; toolchain?: DeclaredService }
  | { kind: "invalid"; reason: string };

/** "python-dev 3.13 (toolchain), postgres 16" for a valid declaration's entries. */
export function declaredServicesLabel(status: { services: DeclaredService[]; toolchain?: DeclaredService }): string {
  return status.services
    .map((service) => `${service.name} ${service.version}${service === status.toolchain ? " (toolchain)" : ""}`)
    .join(", ");
}

/** The committed `.wardby/services.yaml` at `ref`, validated; `dir` must sit inside `roots`. */
export async function inspectDeclaredServices(
  dir: string,
  roots: readonly string[],
  ref: string,
): Promise<DeclaredServicesStatus> {
  let text: string | null;
  try {
    text = await new LocalRemote({ roots: () => roots }).readRepositoryFile({
      repository: `${LOCAL_REPO_PREFIX}${dir}`,
      ref,
      path: SERVICE_DECLARATION_PATH,
      maxBytes: MAX_SERVICE_DECLARATION_BYTES,
    });
  } catch (error) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  if (text === null) return { kind: "absent" };
  try {
    const declaration = parseServiceDeclaration(text);
    return {
      kind: "valid",
      services: declaredEntries(declaration),
      ...(declaration.toolchain ? { toolchain: declaration.toolchain } : {}),
    };
  } catch (error) {
    if (error instanceof ServiceDeclarationError) return { kind: "invalid", reason: error.reason };
    throw error;
  }
}

export type StarterCommitResult =
  | { status: "created" | "replaced"; commit: string }
  | { status: "kept"; commit: string }
  | { status: "refused"; reason: string };

async function currentRef(dir: string): Promise<string | null> {
  try {
    const sha = (await localGit(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", STARTER_REF])).trim();
    return OBJECT_ID.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** True when any worktree of the repository (this one included) has the starter branch checked out. */
async function branchCheckedOut(dir: string): Promise<boolean> {
  const listing = await localGit(dir, ["worktree", "list", "--porcelain"]);
  return listing.split("\n").some((line) => line.trim() === `branch ${STARTER_REF}`);
}

/** The starter commit on top of `baseSha`, built in a scratch index; writes objects only, never a ref. */
async function buildStarterCommit(dir: string, baseSha: string, content: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "wardby-quickstart-index-"));
  try {
    const env = { ...IDENTITY, GIT_INDEX_FILE: join(scratch, "index") };
    await localGitWrite(dir, ["read-tree", "--end-of-options", baseSha], { env });
    const blob = (
      await localGitWrite(dir, ["hash-object", "-w", "--no-filters", "--stdin"], { env, input: content })
    ).trim();
    if (!OBJECT_ID.test(blob)) throw new Error("git hash-object returned no object id");
    await localGitWrite(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${SERVICE_DECLARATION_PATH}`], {
      env,
    });
    const tree = (await localGitWrite(dir, ["write-tree"], { env })).trim();
    if (!OBJECT_ID.test(tree)) throw new Error("git write-tree returned no tree id");
    const commit = (
      await localGitWrite(dir, ["commit-tree", "--no-gpg-sign", "-p", baseSha, "-m", COMMIT_MESSAGE, tree], { env })
    ).trim();
    if (!OBJECT_ID.test(commit)) throw new Error("git commit-tree returned no commit id");
    return commit;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Commits `content` as `.wardby/services.yaml` on top of `baseSha` and points
 * the starter branch at it. An existing branch is replaced only when
 * `confirmReplace` says so, and only if it has not moved since it was read.
 */
export async function commitStarterServices(input: {
  dir: string;
  baseSha: string;
  content: string;
  confirmReplace: (existingSha: string) => Promise<boolean>;
}): Promise<StarterCommitResult> {
  const { dir, baseSha, content } = input;
  if (!OBJECT_ID.test(baseSha)) return { status: "refused", reason: "the base commit id is not valid" };
  // Moving a checked-out branch would change that worktree's HEAD commit under it.
  if (await branchCheckedOut(dir)) {
    return { status: "refused", reason: `${STARTER_SERVICES_BRANCH} is checked out; switch away from it first` };
  }
  const existing = await currentRef(dir);
  if (existing && !(await input.confirmReplace(existing))) return { status: "kept", commit: existing };

  let commit: string;
  try {
    commit = await buildStarterCommit(dir, baseSha, content);
  } catch (error) {
    const detail = ((error as { stderr?: string }).stderr || (error as Error).message).trim().split("\n")[0];
    return { status: "refused", reason: `git could not build the starter commit: ${detail}` };
  }
  // Re-checked right before the move: a checkout since the first check would otherwise be updated under it.
  if (await branchCheckedOut(dir)) {
    return { status: "refused", reason: `${STARTER_SERVICES_BRANCH} is checked out; switch away from it first` };
  }
  const expected = existing ?? "0".repeat(baseSha.length);
  try {
    await localGitWrite(dir, ["update-ref", "--no-deref", "-m", "wardby quickstart", STARTER_REF, commit, expected], {
      env: IDENTITY,
    });
  } catch {
    return {
      status: "refused",
      reason: `${STARTER_SERVICES_BRANCH} changed while quickstart was writing it (or a conflicting ref exists); left as is`,
    };
  }
  return { status: existing ? "replaced" : "created", commit };
}
