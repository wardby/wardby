import { pathToFileURL } from "node:url";
import {
  LOCAL_REPO_PREFIX,
  LocalRepoError,
  normalizeLocalRepository,
  resolveLocalRepository,
} from "../../coding/local-repo.js";
import { COMMIT_SHA } from "../../coding/protocol.js";
import { SHA, isSafeRefName, isSafeRepoPath, localGit, localGitBytes } from "../../coding/local-git.js";
import type { RepositoryFileInput } from "./github.js";
import type { GitRemote, PublishInput, PublishResult } from "./remote.js";

/** The only refs a local remote ever writes into the user's repository. */
const LOCAL_PUSH_REF = /^wardby\/run-[A-Za-z0-9_-]+$/;

export interface LocalRemoteOptions {
  /** Trusted roots (realpaths), re-read on every call so a change takes effect without a restart. */
  roots: () => readonly string[];
}

/**
 * A git repository on the control plane's own disk (`local:/abs/path`).
 *
 * The source repository is touched only by `ls-remote`, the clone's
 * upload-pack, and a push to `refs/heads/wardby/run-*`: the clone goes through
 * a `file://` URL (so `--depth 1` is honored and nothing is hard-linked), never
 * reads the source's working tree, and every hardening check in GitVcsProvider
 * still applies. `protocol.file.allow=always` is set only on this remote's
 * clone/ls-remote/push invocations; HARDENED_GIT_CONFIG's `protocol.allow=never`
 * keeps every other transport off.
 */
export class LocalRemote implements GitRemote {
  readonly gitConfig: readonly string[] = ["-c", "protocol.file.allow=always"];

  constructor(private readonly options: LocalRemoteOptions) {}

  normalizeRepository(repository: string): string {
    return normalizeLocalRepository(repository);
  }

  /** The repository must already be named by its realpath (withAccess verifies it against the roots). */
  cloneUrl(repository: string): string {
    return pathToFileURL(normalizeLocalRepository(repository).slice(LOCAL_REPO_PREFIX.length)).href;
  }

  async withAccess<T>(repository: string, fn: (token: string | undefined) => Promise<T>): Promise<T> {
    const requested = normalizeLocalRepository(repository);
    const resolved = await resolveLocalRepository(requested, this.options.roots());
    // cloneUrl is built from the requested path, so it must be the path that
    // was just checked: a symlinked or otherwise non-canonical name is refused.
    if (resolved.repository !== requested) {
      throw new LocalRepoError("local_repo_not_allowed", "repository must be named by its real path");
    }
    return fn(undefined);
  }

  withReadAccess<T>(repository: string, fn: (token: string | undefined) => Promise<T>): Promise<T> {
    return this.withAccess(repository, fn);
  }

  /** The commit a ref names in the local repository, or null when the ref does not exist. */
  async resolveCommit(repository: string, ref: string): Promise<string | null> {
    const { path: dir } = await resolveLocalRepository(repository, this.options.roots());
    if (!COMMIT_SHA.test(ref) && !(await isSafeRefName(dir, ref))) {
      throw new LocalRepoError("local_ref_invalid", "invalid ref");
    }
    try {
      const sha = (
        await localGit(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], 64 * 1024)
      ).trim();
      return COMMIT_SHA.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /** No pull request to check: a continuation's branch must exist, which prepare's ls-remote pre-check enforces. */
  async assertContinuationOpen(): Promise<void> {}

  /**
   * One committed file at a ref, read from git objects (never the working tree).
   * null = the file does not exist at that ref; a missing ref is
   * local_ref_not_found; a repository outside the roots is refused.
   */
  async readRepositoryFile(input: RepositoryFileInput): Promise<string | null> {
    const { path: dir } = await resolveLocalRepository(input.repository, this.options.roots());
    if (!isSafeRepoPath(input.path)) throw new LocalRepoError("local_path_invalid", "invalid repository file path");
    if (!SHA.test(input.ref) && !(await isSafeRefName(dir, input.ref))) {
      throw new LocalRepoError("local_ref_invalid", "invalid ref");
    }
    let sha: string;
    try {
      sha = (
        await localGit(
          dir,
          ["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.ref}^{commit}`],
          64 * 1024,
        )
      ).trim();
    } catch {
      throw new LocalRepoError("local_ref_not_found", `ref ${input.ref} does not exist in the local repository`);
    }
    if (!SHA.test(sha)) throw new LocalRepoError("local_ref_not_found", `ref ${input.ref} does not exist`);
    const listing = await localGit(dir, ["ls-tree", "-z", "--end-of-options", sha, "--", input.path], 64 * 1024);
    if (!listing) return null;
    if (!/^100(?:644|755) blob /.test(listing)) throw new Error("local_file_not_a_file");
    const object = `${sha}:${input.path}`;
    const size = Number((await localGit(dir, ["cat-file", "-s", "--end-of-options", object], 64 * 1024)).trim());
    if (!Number.isSafeInteger(size) || size > input.maxBytes) throw new Error("local_file_too_large");
    const bytes = await localGitBytes(dir, ["cat-file", "blob", "--end-of-options", object], input.maxBytes + 1024);
    if (bytes.byteLength > input.maxBytes) throw new Error("local_file_too_large");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("local_file_not_utf8");
    }
  }

  async publish({ workspace }: PublishInput): Promise<PublishResult> {
    this.assertPushRef(workspace.headRef);
    return { kind: "branch", branch: workspace.headRef };
  }

  conflictError(): Error {
    return new LocalRepoError(
      "local_branch_conflict",
      "the branch moved in the local repository since the run started",
    );
  }

  refNotFoundError(ref: string): Error {
    return new LocalRepoError("local_ref_not_found", `branch ${ref} does not exist in the local repository`);
  }

  /**
   * receive.denyCurrentBranch=updateInstead (a user setting) would rewrite the
   * working tree of whichever worktree has the pushed branch checked out --
   * the main checkout or any linked worktree -- so refuse before pushing.
   */
  async beforePush(repository: string, headRef: string): Promise<void> {
    const path = normalizeLocalRepository(repository).slice(LOCAL_REPO_PREFIX.length);
    const listing = await localGit(path, ["worktree", "list", "--porcelain"], 1024 * 1024);
    if (listing.split("\n").some((line) => line.trim() === `branch refs/heads/${headRef}`)) {
      throw new LocalRepoError("local_branch_conflict", `branch ${headRef} is checked out in the local repository`);
    }
  }

  assertPushRef(headRef: string): void {
    if (!LOCAL_PUSH_REF.test(headRef)) throw new Error("vcs_head_ref_invalid");
  }
}
