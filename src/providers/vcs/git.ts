import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExcludePathspecs, normalizeCollectExclusions } from "../../coding/collect-exclude.js";
import {
  WARDBY_PROTECTED_PATHS,
  isProtectedPathException,
  isWellFormedProtectedPath,
  protectedPathBody,
  protectsSomePath,
} from "../../coding/protected-paths.js";
import { ensurePrivateDirectory } from "../../core/private-directory.js";
import { simulatorGitEnvironment } from "../../config/test-simulators.js";
import { globRegex } from "../../core/glob.js";
import { redactExactSecretValues } from "../../core/secret-spans.js";
import type { Writable } from "node:stream";
import { MAX_REDACTED_SPAN, redactTokenShapedValues, normalizeGitRef } from "../../coding/protocol.js";
import { isSafeGitHubInstallationToken, type RepositoryFileInput } from "./github.js";
import type { GitRemote } from "./remote.js";
import type {
  ContinuationFinishedDetails,
  ContinuationOutcome,
  ContinuationTarget,
  DescriptionWriteOutcome,
  FinalizeChangesDetails,
  FinalizeChangesResult,
  PreparedWorkspace,
  TargetMerge,
  VcsPrepareInput,
  VcsProvider,
} from "./types.js";

export const DEFAULT_MAX_CHANGED_FILES = 1_000;
export const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 100_000;
const SAFE_COMMIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Where a continuation's target branch is fetched to (never under refs/remotes, so baseCommit's ref is untouched). */
const MERGE_TARGET_REF = "refs/wardby/merge-target";
/** Where the head branch is re-fetched while deepening history (see fetchMergeTarget). */
const MERGE_HEAD_REF = "refs/wardby/merge-head";
/**
 * The trusted automatic merge of the target branch, recorded at prepare time:
 * a commit whose tree is the merge result (markers in conflicted files), whose
 * parents are baseCommit and the target commit, and whose message carries the
 * target ref and the conflicted paths as JSON. Recovery and finalize read it
 * back; the agent's changes are measured against its tree.
 */
const MERGE_STATE_REF = "refs/wardby/merge-state";
const MERGE_STATE_SUBJECT = "wardby merge state";
/** How far `fetch --deepen` goes, step by step, looking for a merge base in a depth-1 clone. */
const MERGE_BASE_DEEPEN_STEPS = [64, 256, 1024, 4096] as const;
/** A conflict marker pair at the start of a line: git writes 7 characters (any longer run counts too), then a space or the line end. */
const CONFLICT_MARKER_START = /^<{7,}(?: |\r?$)/m;
const CONFLICT_MARKER_END = /^>{7,}(?: |\r?$)/m;
const HARDENED_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
] as const;

export interface GitCommandOptions {
  cwd?: string;
  authToken?: string;
  maxOutputBytes?: number;
  /** Non-zero exit codes that still resolve with the output (`merge-tree` exits 1 on conflicts). */
  acceptExitCodes?: readonly number[];
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandRunner {
  run(args: readonly string[], options?: GitCommandOptions): Promise<GitCommandResult>;
}

export class GitCommandError extends Error {
  constructor(
    public readonly exitCode: number | null,
    detail: string,
  ) {
    super(`git_command_failed:${exitCode ?? "spawn"}${detail ? `:${detail}` : ""}`);
  }
}

const GIT_OUTPUT_DISPLAY_BYTES = 8 * 1024;

export function redactGitOutput(value: string, secrets: readonly string[] = []): string {
  // Only the first 8 KiB is ever kept, so redaction works on that plus one
  // MAX_REDACTED_SPAN of margin rather than on all 2 MiB git may have produced
  // (see redactAndTruncate: the margin is what keeps truncation safe). The rest
  // is discarded here and never reaches a log or the database.
  // The shared span-union redactor; any non-empty value counts here, as it always has.
  const output = redactExactSecretValues(value.slice(0, GIT_OUTPUT_DISPLAY_BYTES + MAX_REDACTED_SPAN), secrets, {
    minLength: 1,
  });
  return redactTokenShapedValues(output).slice(0, GIT_OUTPUT_DISPLAY_BYTES);
}

export interface NodeGitCommandRunnerOptions {
  gitBinary?: string;
  path?: string;
  homeDir: string;
  askPassPath?: string;
}

/** Runs Git without a shell or inherited application secrets. */
export class NodeGitCommandRunner implements GitCommandRunner {
  private readonly gitBinary: string;
  private readonly path: string;
  private readonly askPassPath: string;

  constructor(private readonly options: NodeGitCommandRunnerOptions) {
    this.gitBinary = options.gitBinary ?? "git";
    this.path = options.path ?? "/usr/bin:/bin";
    this.askPassPath =
      options.askPassPath ?? fileURLToPath(new URL("../../../scripts/git-askpass.sh", import.meta.url));
  }

  async run(args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
    if (options.authToken !== undefined && !isSafeGitHubInstallationToken(options.authToken)) {
      throw new Error("git_auth_token_invalid");
    }
    const env: NodeJS.ProcessEnv = {
      PATH: this.path,
      HOME: this.options.homeDir,
      XDG_CONFIG_HOME: this.options.homeDir,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: options.authToken ? this.askPassPath : "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GIT_LFS_SKIP_SMUDGE: "1",
      // WARDBY_TEST_SIMULATORS (test only): the simulator's throwaway CA; empty otherwise.
      ...simulatorGitEnvironment(),
    };
    const maxBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
    const secrets = options.authToken ? [options.authToken] : [];

    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.gitBinary, [...args], {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", options.authToken ? "pipe" : "ignore"],
      });
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      if (!childStdout || !childStderr) {
        child.kill("SIGKILL");
        rejectPromise(new GitCommandError(null, "git_stdio_unavailable"));
        return;
      }
      if (options.authToken) {
        const authPipe = child.stdio[3] as Writable;
        authPipe.on("error", () => undefined);
        authPipe.end(`${options.authToken}\n`);
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let outputExceeded = false;
      let spawnError = false;

      const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      };
      childStdout.on("data", capture(stdout));
      childStderr.on("data", capture(stderr));
      child.once("error", () => {
        spawnError = true;
      });
      child.once("close", (code) => {
        if (outputExceeded) {
          rejectPromise(new GitCommandError(code, "git_output_limit"));
          return;
        }
        if (spawnError) {
          rejectPromise(new GitCommandError(null, "git_spawn_failed"));
          return;
        }
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: redactGitOutput(Buffer.concat(stderr).toString("utf8"), secrets),
        };
        if (code !== 0 && (code === null || !options.acceptExitCodes?.includes(code))) {
          rejectPromise(new GitCommandError(code, result.stderr.trim()));
          return;
        }
        resolvePromise(result);
      });
    });
  }
}

export interface GitVcsProviderOptions {
  rootDir: string;
  /** Where repositories are cloned from and pushed to (GitHubRemote in production). */
  remote: GitRemote;
  git?: GitCommandRunner;
  maxChangedFiles?: number;
  maxDiffBytes?: number;
}

/** Validates one protectedPaths entry; a leading "!" makes it an exception (see protectedPathMatcher). */
function validateProtectedPath(value: string): string {
  const path = value.trim();
  if (Buffer.byteLength(path, "utf8") > 512 || !isWellFormedProtectedPath(path)) {
    throw new Error("vcs_protected_path_invalid");
  }
  return path;
}

/** The fixed baseline, split once: its literal exceptions and its protected globs. */
const WARDBY_UNPROTECTED = new Set(WARDBY_PROTECTED_PATHS.filter(isProtectedPathException).map(protectedPathBody));
const WARDBY_PROTECTED = WARDBY_PROTECTED_PATHS.filter((pattern) => !isProtectedPathException(pattern)).map((pattern) =>
  globRegex(pattern),
);

/**
 * Whether a changed path is protected, in this order: the WARDBY_PROTECTED_PATHS
 * baseline's exception (.wardby/services.yaml, which a builder may propose; it
 * takes effect only after merge, docs/coding-services.md) is never protected;
 * anything else under the baseline (.wardby/**) always is, whatever the agent's
 * exceptions say; any other path is protected when it matches one of the
 * agent's `patterns` and is not one of its exceptions (entries with a leading
 * "!", each a literal path, so order does not matter). The baseline is applied
 * here, at enforcement, rather than stored, so every existing agent and
 * in-flight run gets it.
 */
export function protectedPathMatcher(patterns: readonly string[]): (path: string) => boolean {
  const exceptions = new Set(patterns.filter(isProtectedPathException).map(protectedPathBody));
  const protectedPatterns = patterns
    .filter((pattern) => !isProtectedPathException(pattern))
    .map((pattern) => globRegex(pattern));
  return (path) => {
    if (WARDBY_UNPROTECTED.has(path)) return false;
    if (WARDBY_PROTECTED.some((matcher) => matcher.test(path))) return true;
    return protectedPatterns.some((matcher) => matcher.test(path)) && !exceptions.has(path);
  };
}

export function validateChangedPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("vcs_changed_path_invalid");
  }
  return path;
}

function nullSeparated(value: string): string[] {
  const values = value.split("\0");
  if (values.at(-1) === "") values.pop();
  return values.map(validateChangedPath);
}

function safeGitRef(value: string): string | null {
  try {
    return normalizeGitRef(value);
  } catch {
    return null;
  }
}

/** The merge state's message: a fixed subject, then the target ref and conflicted paths as JSON. */
function mergeStateMessage(targetMerge: Pick<TargetMerge, "ref" | "conflictedPaths">): string {
  return `${MERGE_STATE_SUBJECT}\n\n${JSON.stringify({ ref: targetMerge.ref, conflicted: targetMerge.conflictedPaths })}\n`;
}

function sameTargetMerge(left: TargetMerge | undefined, right: TargetMerge | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.ref === right.ref &&
    left.targetCommit === right.targetCommit &&
    left.conflictedPaths.length === right.conflictedPaths.length &&
    left.conflictedPaths.every((path, index) => path === right.conflictedPaths[index])
  );
}

function directChild(root: string, child: string): boolean {
  return child.startsWith(`${root}${sep}`) && !child.slice(root.length + 1).includes(sep);
}

export class GitVcsProvider implements VcsProvider {
  private readonly rootDir: string;
  private readonly git: GitCommandRunner;
  private readonly maxChangedFiles: number;
  private readonly maxDiffBytes: number;
  private readonly remote: GitRemote;

  constructor(options: GitVcsProviderOptions) {
    this.rootDir = resolve(options.rootDir);
    if (this.rootDir === resolve("/")) throw new Error("vcs_root_invalid");
    this.git = options.git ?? new NodeGitCommandRunner({ homeDir: resolve(this.rootDir, ".home") });
    this.maxChangedFiles = options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
    this.maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
    if (
      !Number.isSafeInteger(this.maxChangedFiles) ||
      this.maxChangedFiles <= 0 ||
      !Number.isSafeInteger(this.maxDiffBytes) ||
      this.maxDiffBytes <= 0
    ) {
      throw new Error("vcs_limits_invalid");
    }
    this.remote = options.remote;
  }

  async prepareWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace> {
    const normalized = this.validateInput(input);
    await this.remote.assertContinuationOpen(normalized);
    await ensurePrivateDirectory(this.rootDir);
    await mkdir(resolve(this.rootDir, ".home"), { recursive: true, mode: 0o700 });
    const runRoot = resolve(this.rootDir, normalized.runId);
    if (!directChild(this.rootDir, runRoot)) throw new Error("vcs_workspace_path_invalid");
    try {
      await mkdir(runRoot, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("vcs_workspace_exists", { cause: error });
      throw error;
    }
    const workspacePath = resolve(runRoot, "workspace");
    const gitMetadataPath = resolve(runRoot, "git");
    // The remote validates its own URL (GitHubRemote: vcs_remote_invalid
    // unless it is exactly github.com's, outside the test-only override).
    const cloneUrl = this.remote.cloneUrl(normalized.repository);
    // Revision-in-place: a continuation clones the EXISTING headRef branch
    // directly (its current tip becomes baseCommit below) instead of
    // baseRef -- everything after this line (branch/checkout/reset, and
    // every check in finalizeChanges) is unchanged either way, since
    // baseCommit already means exactly what it needs to: "where this
    // round started."
    const cloneBranch = normalized.continuation ? normalized.headRef : normalized.baseRef;
    // A continuation is first brought up to date with the branch its pull
    // request targets now (a person may have retargeted it since the root run).
    const target = normalized.continuation ? await this.remote.pullRequestBase?.(normalized) : null;
    const mergeRef = target ? safeGitRef(target.ref) : null;
    let mergeFetched = false;

    try {
      await this.remote.withAccess(normalized.repository, async (token) => {
        const auth = token !== undefined ? { authToken: token } : {};
        if (this.remote.refNotFoundError) {
          const listed = await this.git.run(
            [
              ...HARDENED_GIT_CONFIG,
              ...this.remote.gitConfig,
              "ls-remote",
              "--heads",
              cloneUrl,
              `refs/heads/${cloneBranch}`,
            ],
            { cwd: runRoot, ...auth },
          );
          const found = listed.stdout.split("\n").some((line) => line.split("\t")[1] === `refs/heads/${cloneBranch}`);
          if (!found) throw this.remote.refNotFoundError(cloneBranch);
        }
        await this.git.run(
          [
            ...HARDENED_GIT_CONFIG,
            ...this.remote.gitConfig,
            "clone",
            "--no-checkout",
            "--single-branch",
            "--no-tags",
            // History is never needed: the worker gets no Git metadata, the
            // finalizer compares only against baseCommit and the new commit's
            // parent, and pushOnce compares SHAs. Depth 1 keeps large
            // repositories' history off the control plane's disk.
            "--depth",
            "1",
            "--branch",
            cloneBranch,
            "--separate-git-dir",
            gitMetadataPath,
            cloneUrl,
            workspacePath,
          ],
          { cwd: runRoot, ...auth },
        );
        if (mergeRef && mergeRef !== normalized.headRef) {
          mergeFetched = await this.fetchMergeTarget(gitMetadataPath, workspacePath, cloneBranch, mergeRef, auth);
        }
      });
      await rm(resolve(workspacePath, ".git"), { force: true });
      const baseCommit = await this.revParseRaw(
        gitMetadataPath,
        workspacePath,
        `refs/remotes/origin/${cloneBranch}^{commit}`,
      );
      await this.gitForPaths(gitMetadataPath, workspacePath, ["config", "--local", "core.hooksPath", "/dev/null"]);
      await this.gitForPaths(gitMetadataPath, workspacePath, ["config", "--local", "commit.gpgSign", "false"]);
      await this.gitForPaths(gitMetadataPath, workspacePath, ["config", "--local", "tag.gpgSign", "false"]);
      await this.gitForPaths(gitMetadataPath, workspacePath, ["config", "--local", "user.name", "Wardby"]);
      await this.gitForPaths(gitMetadataPath, workspacePath, [
        "config",
        "--local",
        "user.email",
        "wardby@users.noreply.github.com",
      ]);
      // Revision-in-place: a continuation's clone (--branch === headRef, above)
      // already leaves headRef checked out locally, pointing at exactly
      // baseCommit -- `branch --force` on an already-checked-out branch is
      // both unnecessary here and something Git refuses outright ("cannot
      // force update the branch ... checked out"). Only a fresh run (cloned
      // baseRef, a DIFFERENT name from headRef) needs this to create headRef.
      if (!normalized.continuation) {
        await this.gitForPaths(gitMetadataPath, workspacePath, ["branch", "--force", normalized.headRef, baseCommit]);
      }
      await this.gitForPaths(gitMetadataPath, workspacePath, [
        "symbolic-ref",
        "HEAD",
        `refs/heads/${normalized.headRef}`,
      ]);
      const merged =
        mergeFetched && mergeRef
          ? await this.mergeTargetBranch(gitMetadataPath, workspacePath, baseCommit, mergeRef)
          : null;
      await this.gitForPaths(gitMetadataPath, workspacePath, [
        "read-tree",
        "--reset",
        "-u",
        merged?.tree ?? baseCommit,
      ]);
      await this.inspectWorkspace(workspacePath);

      return {
        id: `vcs-${normalized.runId}`,
        ...normalized,
        baseCommit,
        workspacePath,
        gitMetadataPath,
        ...(merged ? { targetMerge: merged.targetMerge } : {}),
      };
    } catch (error) {
      await rm(runRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async recoverWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace | null> {
    const normalized = this.validateInput(input);
    const expected = this.expectedPaths(normalized.runId);
    try {
      const metadata = await lstat(expected.runRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("vcs_workspace_path_invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    const cloneBranch = normalized.continuation ? normalized.headRef : normalized.baseRef;
    const baseCommit = await this.revParseRaw(
      expected.gitMetadataPath,
      expected.workspacePath,
      `refs/remotes/origin/${cloneBranch}^{commit}`,
    );
    const recovered: PreparedWorkspace = {
      id: `vcs-${normalized.runId}`,
      ...normalized,
      baseCommit,
      workspacePath: expected.workspacePath,
      gitMetadataPath: expected.gitMetadataPath,
    };
    const prepared = await this.validatePrepared(recovered);
    await this.inspectWorkspace(prepared.workspacePath);
    await this.assertRemote(prepared);
    await this.assertSafeLocalConfig(prepared.gitMetadataPath);
    const symbolicHead = (await this.gitFor(prepared, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (symbolicHead !== prepared.headRef) throw new Error("vcs_head_ref_mismatch");
    const merge = await this.readMergeState(prepared);
    const currentHead = await this.revParse(prepared, "HEAD");
    if (currentHead !== prepared.baseCommit) {
      const parent = await this.revParse(prepared, "HEAD^");
      if (parent !== prepared.baseCommit) throw new Error("vcs_commit_history_invalid");
      if (merge && (await this.revParse(prepared, "HEAD^2")) !== merge.targetCommit) {
        throw new Error("vcs_commit_history_invalid");
      }
    }
    if (!merge) return prepared;
    const { stateCommit: _stateCommit, ...targetMerge } = merge;
    return { ...prepared, targetMerge };
  }

  async finalizeChanges(
    workspace: PreparedWorkspace,
    details?: FinalizeChangesDetails,
  ): Promise<FinalizeChangesResult> {
    const prepared = await this.validatePrepared(workspace);
    await this.inspectWorkspace(prepared.workspacePath);
    await this.assertRemote(prepared);
    await this.assertSafeLocalConfig(prepared.gitMetadataPath);
    // The merge state on disk is the trusted record; the handle must agree with it.
    const merge = await this.readMergeState(prepared);
    if (!sameTargetMerge(merge, prepared.targetMerge)) throw new Error("vcs_workspace_handle_invalid");
    // Excluded paths (src/coding/collect-exclude.ts) are never collected from the worker, so
    // they are also neither added nor deleted here: tracked files under them stay untouched.
    await this.gitFor(prepared, [
      "add",
      "--all",
      "--",
      ":/",
      ...gitExcludePathspecs(normalizeCollectExclusions(prepared.collectExclude)),
    ]);
    // Every check below applies to the agent's own changes: against baseCommit, or, after a
    // merge, against the trusted automatic merge result (so the target branch's own changes,
    // protected paths included, pass, while any agent edit -- a conflict it resolved, a
    // target change it reverted -- is checked).
    const comparedTo = merge?.stateCommit ?? prepared.baseCommit;
    const changed = nullSeparated(
      (await this.gitFor(prepared, ["diff", "--cached", "--name-only", "-z", "--no-renames", comparedTo, "--"])).stdout,
    );
    if (changed.length > this.maxChangedFiles) throw new Error("vcs_changed_file_limit");
    const protectedChange = changed.find(protectedPathMatcher(prepared.protectedPaths));
    if (protectedChange) throw new Error(`vcs_protected_path:${protectedChange}`);

    let diff: string;
    try {
      diff = (
        await this.gitFor(
          prepared,
          ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", comparedTo, "--"],
          { maxOutputBytes: this.maxDiffBytes },
        )
      ).stdout;
    } catch (error) {
      if (error instanceof GitCommandError && error.message.includes("git_output_limit")) {
        throw new Error("vcs_diff_size_limit", { cause: error });
      }
      throw error;
    }
    if (Buffer.byteLength(diff, "utf8") > this.maxDiffBytes) throw new Error("vcs_diff_size_limit");
    // After the size limits, so a conflicted file is never read past what the diff limit allows.
    if (merge) await this.assertConflictsResolved(prepared.workspacePath, merge.conflictedPaths);
    const currentHead = await this.revParse(prepared, "HEAD");
    // A merge with no agent edits still has the merge itself to push.
    if (!merge && changed.length === 0 && currentHead === prepared.baseCommit) {
      return {
        outcome: "no_changes",
        repository: prepared.repository,
        baseRef: prepared.baseRef,
        baseCommit: prepared.baseCommit,
      };
    }

    const symbolicHead = (await this.gitFor(prepared, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (symbolicHead !== prepared.headRef) throw new Error("vcs_head_ref_mismatch");
    let commitSha: string;
    if (currentHead === prepared.baseCommit && merge) {
      commitSha = await this.commitMerge(prepared, merge);
    } else if (currentHead === prepared.baseCommit) {
      await this.gitFor(prepared, ["commit", "--no-verify", "--no-gpg-sign", "-m", `Wardby run ${prepared.runId}`]);
      commitSha = await this.revParse(prepared, "HEAD");
    } else {
      const parent = await this.revParse(prepared, "HEAD^");
      if (parent !== prepared.baseCommit) throw new Error("vcs_commit_history_invalid");
      if (merge && (await this.revParse(prepared, "HEAD^2")) !== merge.targetCommit) {
        throw new Error("vcs_commit_history_invalid");
      }
      const afterCommitChanges = nullSeparated(
        (await this.gitFor(prepared, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"])).stdout,
      );
      if (afterCommitChanges.length > 0) throw new Error("vcs_finalized_workspace_changed");
      commitSha = currentHead;
    }

    await this.remote.assertContinuationOpen(prepared);
    // Before the push: a description comment must already exist when the push starts a review.
    await this.remote
      .proposeDescriptionBeforePush?.({ workspace: prepared, details, changedPaths: changed, commitSha })
      .catch(() => undefined);
    await this.pushOnce(prepared, commitSha);
    const published = await this.remote.publish({ workspace: prepared, details, changedPaths: changed, commitSha });
    if (published.kind === "branch") {
      if (published.branch !== prepared.headRef) throw new Error("vcs_head_ref_mismatch");
      return {
        outcome: "branch_pushed",
        repository: prepared.repository,
        baseRef: prepared.baseRef,
        baseCommit: prepared.baseCommit,
        headRef: prepared.headRef,
        commitSha,
      };
    }
    return {
      outcome: prepared.continuation ? "pull_request_updated" : "pull_request_opened",
      repository: prepared.repository,
      baseRef: prepared.baseRef,
      baseCommit: prepared.baseCommit,
      headRef: prepared.headRef,
      commitSha,
      pullRequestNumber: published.number,
      pullRequestUrl: published.url,
      ...(published.description ? { description: published.description } : {}),
      ...(merge && prepared.continuation
        ? {
            targetMerge: {
              ref: merge.ref,
              targetCommit: merge.targetCommit,
              conflicts: merge.conflictedPaths.length,
            },
          }
        : {}),
    };
  }

  /** The two-parent merge commit (baseCommit, the target) of the staged tree, as the Wardby identity. */
  private async commitMerge(prepared: PreparedWorkspace, merge: TargetMerge): Promise<string> {
    const tree = (await this.gitFor(prepared, ["write-tree"])).stdout.trim();
    if (!SAFE_COMMIT_SHA.test(tree)) throw new Error("vcs_commit_sha_invalid");
    const commitSha = (
      await this.gitFor(prepared, [
        "commit-tree",
        tree,
        "-p",
        prepared.baseCommit,
        "-p",
        merge.targetCommit,
        "-m",
        `Merge ${merge.ref} into ${prepared.headRef} (Wardby run ${prepared.runId})`,
      ])
    ).stdout.trim();
    if (!SAFE_COMMIT_SHA.test(commitSha)) throw new Error("vcs_commit_sha_invalid");
    await this.gitFor(prepared, ["update-ref", `refs/heads/${prepared.headRef}`, commitSha, prepared.baseCommit]);
    return commitSha;
  }

  /** Re-derive a continuation's PR description without a push, delegated to the remote; never throws. */
  async refreshPullRequestDescription(
    workspace: ContinuationTarget,
    details: FinalizeChangesDetails,
  ): Promise<DescriptionWriteOutcome | undefined> {
    try {
      return await this.remote.refreshDescription?.(workspace, details);
    } catch {
      return { kind: "skipped", reason: "error" };
    }
  }

  async cleanup(workspace: PreparedWorkspace): Promise<void> {
    const expected = this.expectedPaths(workspace.runId);
    if (
      workspace.id !== `vcs-${workspace.runId}` ||
      workspace.workspacePath !== expected.workspacePath ||
      workspace.gitMetadataPath !== expected.gitMetadataPath
    ) {
      throw new Error("vcs_workspace_handle_invalid");
    }
    await rm(expected.runRoot, { recursive: true, force: true });
  }

  /**
   * Best-effort "wardby is working on this PR" signal (see VcsProvider),
   * delegated to the remote; a remote without one is a no-op. Wrapped so
   * this can NEVER throw or otherwise affect the real coding run.
   */
  /** Delegated to the remote; never throws (undefined on any failure). */
  async continuationPullRequestDraft(workspace: PreparedWorkspace): Promise<boolean | undefined> {
    try {
      return await this.remote.continuationPullRequestDraft?.(workspace);
    } catch {
      return undefined;
    }
  }

  async notifyContinuationStarted(workspace: PreparedWorkspace, details?: { agentName?: string }): Promise<void> {
    try {
      await this.remote.notifyContinuationStarted?.(workspace, details);
    } catch {
      // Best-effort observability only -- must never affect the real run.
    }
  }

  /** Companion to notifyContinuationStarted, delegated to the remote under the same never-throw contract. */
  async notifyContinuationFinished(
    workspace: ContinuationTarget,
    outcome: ContinuationOutcome,
    details?: ContinuationFinishedDetails,
  ): Promise<void> {
    try {
      await this.remote.notifyContinuationFinished?.(workspace, outcome, details);
    } catch {
      // Best-effort observability only -- must never affect the real run.
    }
  }

  async readRepositoryFile(input: RepositoryFileInput): Promise<string | null> {
    if (!this.remote.readRepositoryFile) throw new Error("vcs_read_file_unsupported");
    return this.remote.readRepositoryFile(input);
  }

  private validateInput(
    input: VcsPrepareInput,
  ): Omit<PreparedWorkspace, "id" | "baseCommit" | "workspacePath" | "gitMetadataPath"> {
    if (!SAFE_RUN_ID.test(input.runId)) throw new Error("vcs_run_id_invalid");
    const repository = this.remote.normalizeRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    // Revision-in-place: a continuation's headRef legitimately belongs to a
    // DIFFERENT run (the one that originally opened the PR), so it can't
    // match this run's own derived pattern -- it must instead match that
    // run's. The caller (dispatch.ts) is responsible for having verified,
    // against the database, that this run is actually allowed to continue
    // that branch before ever setting `continuation`; this is a structural
    // check only, not the security boundary.
    let continuation: { rootRunId: string } | undefined;
    if (input.continuation) {
      if (!SAFE_RUN_ID.test(input.continuation.rootRunId)) throw new Error("vcs_root_run_id_invalid");
      if (headRef !== `wardby/run-${input.continuation.rootRunId}`) throw new Error("vcs_head_ref_invalid");
      continuation = { rootRunId: input.continuation.rootRunId };
    } else if (headRef !== `wardby/run-${input.runId}`) {
      throw new Error("vcs_head_ref_invalid");
    }
    const protectedPaths = [...new Set(input.protectedPaths.map(validateProtectedPath))];
    if (protectedPaths.length === 0 || protectedPaths.length > 128) throw new Error("vcs_protected_paths_invalid");
    if (!protectsSomePath(protectedPaths)) throw new Error("vcs_protected_paths_invalid");
    const collectExclude = [...normalizeCollectExclusions(input.collectExclude ?? []).paths];
    return { runId: input.runId, repository, baseRef, headRef, protectedPaths, collectExclude, continuation };
  }

  private expectedPaths(runId: string): { runRoot: string; workspacePath: string; gitMetadataPath: string } {
    if (!SAFE_RUN_ID.test(runId)) throw new Error("vcs_workspace_handle_invalid");
    const runRoot = resolve(this.rootDir, runId);
    if (!directChild(this.rootDir, runRoot)) throw new Error("vcs_workspace_handle_invalid");
    return {
      runRoot,
      workspacePath: resolve(runRoot, "workspace"),
      gitMetadataPath: resolve(runRoot, "git"),
    };
  }

  private async validatePrepared(workspace: PreparedWorkspace): Promise<PreparedWorkspace> {
    const normalized = this.validateInput(workspace);
    const expected = this.expectedPaths(normalized.runId);
    if (
      workspace.id !== `vcs-${normalized.runId}` ||
      !SAFE_COMMIT_SHA.test(workspace.baseCommit) ||
      workspace.repository !== normalized.repository ||
      workspace.baseRef !== normalized.baseRef ||
      workspace.headRef !== normalized.headRef ||
      workspace.workspacePath !== expected.workspacePath ||
      workspace.gitMetadataPath !== expected.gitMetadataPath ||
      workspace.protectedPaths.length !== normalized.protectedPaths.length ||
      workspace.protectedPaths.some((path, index) => path !== normalized.protectedPaths[index]) ||
      workspace.collectExclude.length !== normalized.collectExclude.length ||
      workspace.collectExclude.some((path, index) => path !== normalized.collectExclude[index]) ||
      workspace.continuation?.rootRunId !== normalized.continuation?.rootRunId
    ) {
      throw new Error("vcs_workspace_handle_invalid");
    }
    const [rootReal, runRootReal, workspaceReal, metadataReal] = await Promise.all([
      realpath(this.rootDir),
      realpath(expected.runRoot),
      realpath(expected.workspacePath),
      realpath(expected.gitMetadataPath),
    ]);
    if (
      runRootReal !== resolve(rootReal, workspace.runId) ||
      workspaceReal !== resolve(runRootReal, "workspace") ||
      metadataReal !== resolve(runRootReal, "git")
    ) {
      throw new Error("vcs_workspace_path_invalid");
    }
    return { ...workspace, ...normalized };
  }

  /**
   * Fetches a continuation's target branch from the same `origin` the clone
   * came from (never another URL, so never a fork) and deepens the depth-1
   * clone step by step until the head and the target share a merge base.
   * Returns true once they do; throws vcs_target_merge_failed when the fetch
   * fails or no merge base turns up within MERGE_BASE_DEEPEN_STEPS.
   */
  private async fetchMergeTarget(
    gitMetadataPath: string,
    workspacePath: string,
    cloneBranch: string,
    ref: string,
    auth: { authToken?: string },
  ): Promise<boolean> {
    const fetch = (depth: readonly string[], refspec: string) =>
      this.gitForPaths(
        gitMetadataPath,
        workspacePath,
        [...this.remote.gitConfig, "fetch", "--no-tags", "--no-write-fetch-head", ...depth, "origin", refspec],
        auth,
      );
    const target = `+refs/heads/${ref}:${MERGE_TARGET_REF}`;
    // The head is deepened through its own ref under refs/wardby, so the clone's
    // refs/remotes/origin/<head> (baseCommit) never moves.
    const head = `+refs/heads/${cloneBranch}:${MERGE_HEAD_REF}`;
    try {
      await fetch(["--depth", "1"], target);
      for (const step of [0, ...MERGE_BASE_DEEPEN_STEPS]) {
        if (step > 0) {
          // One fetch per side: newer git deepens only the refs a fetch names
          // (older git deepened every shallow boundary), and a fetch naming
          // both deepens only one of them.
          await fetch([`--deepen=${step}`], head);
          await fetch([`--deepen=${step}`], target);
        }
        const base = await this.gitForPaths(
          gitMetadataPath,
          workspacePath,
          ["merge-base", `refs/remotes/origin/${cloneBranch}`, MERGE_TARGET_REF],
          { acceptExitCodes: [1] },
        );
        if (base.stdout.trim()) return true;
      }
    } catch (error) {
      throw new Error("vcs_target_merge_failed", { cause: error });
    }
    throw new Error("vcs_target_merge_failed");
  }

  /**
   * Merges the fetched target into baseCommit without touching the index or
   * the working tree (`merge-tree --write-tree`: no MERGE_HEAD, no hooks, no
   * merge drivers -- none are configured), and records the result as the merge
   * state. Null when the target is already part of the branch (nothing to merge).
   */
  private async mergeTargetBranch(
    gitMetadataPath: string,
    workspacePath: string,
    baseCommit: string,
    ref: string,
  ): Promise<{ tree: string; targetMerge: TargetMerge } | null> {
    const targetCommit = await this.revParseRaw(gitMetadataPath, workspacePath, `${MERGE_TARGET_REF}^{commit}`);
    const mergeBase = (
      await this.gitForPaths(gitMetadataPath, workspacePath, ["merge-base", baseCommit, targetCommit])
    ).stdout.trim();
    if (mergeBase === targetCommit) return null;
    // The clone is --no-checkout and nothing is read into the index or the
    // working tree until after this merge, so no repository .gitattributes
    // (a marker size, `-merge`, `merge=union`) can steer it.
    let output: string;
    try {
      output = (
        await this.gitForPaths(
          gitMetadataPath,
          workspacePath,
          ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", baseCommit, targetCommit],
          { acceptExitCodes: [1] },
        )
      ).stdout;
    } catch (error) {
      throw new Error("vcs_target_merge_failed", { cause: error });
    }
    const [tree, ...paths] = output.split("\0");
    if (!SAFE_COMMIT_SHA.test(tree)) throw new Error("vcs_target_merge_failed");
    const conflictedPaths = [...new Set(paths.filter(Boolean))].map(validateChangedPath);
    if (conflictedPaths.length > this.maxChangedFiles) throw new Error("vcs_target_merge_failed");
    const targetMerge: TargetMerge = { ref, targetCommit, conflictedPaths };
    // The message goes through a file: a long conflicted-path list could pass an argument's size limit.
    const messagePath = resolve(gitMetadataPath, "WARDBY_MERGE_STATE_MSG");
    await writeFile(messagePath, mergeStateMessage(targetMerge), { mode: 0o600 });
    try {
      const stateCommit = (
        await this.gitForPaths(gitMetadataPath, workspacePath, [
          "commit-tree",
          tree,
          "-p",
          baseCommit,
          "-p",
          targetCommit,
          "-F",
          messagePath,
        ])
      ).stdout.trim();
      if (!SAFE_COMMIT_SHA.test(stateCommit)) throw new Error("vcs_commit_sha_invalid");
      await this.gitForPaths(gitMetadataPath, workspacePath, ["update-ref", MERGE_STATE_REF, stateCommit]);
    } finally {
      await rm(messagePath, { force: true });
    }
    return { tree, targetMerge };
  }

  /** The recorded merge state (see MERGE_STATE_REF), validated, or undefined when the workspace merged nothing. */
  private async readMergeState(
    workspace: Pick<PreparedWorkspace, "gitMetadataPath" | "workspacePath" | "baseCommit">,
  ): Promise<(TargetMerge & { stateCommit: string }) | undefined> {
    const { gitMetadataPath, workspacePath } = workspace;
    const stateCommit = (
      await this.gitForPaths(gitMetadataPath, workspacePath, [
        "for-each-ref",
        "--format=%(objectname)",
        MERGE_STATE_REF,
      ])
    ).stdout.trim();
    if (!stateCommit) return undefined;
    if (!SAFE_COMMIT_SHA.test(stateCommit)) throw new Error("vcs_merge_state_invalid");
    const raw = (await this.gitForPaths(gitMetadataPath, workspacePath, ["cat-file", "commit", stateCommit])).stdout;
    const split = raw.indexOf("\n\n");
    if (split < 0) throw new Error("vcs_merge_state_invalid");
    const parents = raw
      .slice(0, split)
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length));
    const message = raw.slice(split + 2);
    if (
      parents.length !== 2 ||
      parents[0] !== workspace.baseCommit ||
      !SAFE_COMMIT_SHA.test(parents[1]) ||
      !message.startsWith(`${MERGE_STATE_SUBJECT}\n\n`)
    ) {
      throw new Error("vcs_merge_state_invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.slice(MERGE_STATE_SUBJECT.length + 2));
    } catch (error) {
      throw new Error("vcs_merge_state_invalid", { cause: error });
    }
    const state = parsed as { ref?: unknown; conflicted?: unknown };
    if (
      typeof state.ref !== "string" ||
      !Array.isArray(state.conflicted) ||
      state.conflicted.length > this.maxChangedFiles ||
      state.conflicted.some((path) => typeof path !== "string")
    ) {
      throw new Error("vcs_merge_state_invalid");
    }
    const ref = safeGitRef(state.ref);
    if (!ref) throw new Error("vcs_merge_state_invalid");
    return {
      ref,
      targetCommit: parents[1],
      conflictedPaths: (state.conflicted as string[]).map(validateChangedPath),
      stateCommit,
    };
  }

  /**
   * Refuses to finalize while a file the merge left conflicted still holds a
   * conflict marker pair. Only those files are read: elsewhere a line of
   * `<<<<<<<` may be legitimate content (a fixture, a doc about merging).
   */
  private async assertConflictsResolved(workspacePath: string, conflictedPaths: readonly string[]): Promise<void> {
    for (const path of conflictedPaths) {
      const fullPath = resolve(workspacePath, path);
      if (!fullPath.startsWith(`${workspacePath}${sep}`)) throw new Error("vcs_changed_path_invalid");
      // One no-follow open, then stat and read through that handle: nothing can swap the file in between.
      let handle: FileHandle;
      try {
        handle = await open(fullPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Deleted while resolving, or a symlink (ELOOP): nothing left to hold a marker.
        if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") continue;
        throw error;
      }
      let content: string;
      try {
        // Not a regular file (a directory now stands there): nothing to scan.
        if (!(await handle.stat()).isFile()) continue;
        content = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      if (CONFLICT_MARKER_START.test(content) && CONFLICT_MARKER_END.test(content)) {
        throw new Error(`vcs_conflict_markers_remain:${path}`);
      }
    }
  }

  private async inspectWorkspace(workspacePath: string): Promise<void> {
    const rootStat = await lstat(workspacePath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("vcs_workspace_path_invalid");
    let entries = 0;
    const visit = async (directory: string): Promise<void> => {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        entries += 1;
        if (entries > MAX_WORKSPACE_ENTRIES) throw new Error("vcs_workspace_entry_limit");
        if (entry.name.toLowerCase() === ".git") throw new Error("vcs_nested_repository");
        const fullPath = resolve(directory, entry.name);
        const stat = await lstat(fullPath);
        if (stat.isSymbolicLink()) {
          const target = await readlink(fullPath);
          const resolvedTarget = resolve(directory, target);
          if (
            isAbsolute(target) ||
            (resolvedTarget !== workspacePath && !resolvedTarget.startsWith(`${workspacePath}${sep}`))
          ) {
            throw new Error("vcs_symlink_escape");
          }
        } else if (stat.isDirectory()) {
          await visit(fullPath);
        } else if (!stat.isFile()) {
          throw new Error("vcs_special_file");
        }
      }
    };
    await visit(workspacePath);
  }

  private async assertRemote(workspace: PreparedWorkspace): Promise<void> {
    const expectedUrl = this.remote.cloneUrl(workspace.repository);
    const remotes = (await this.gitFor(workspace, ["remote"])).stdout.trim().split("\n").filter(Boolean);
    const fetchUrls = (await this.gitFor(workspace, ["remote", "get-url", "--all", "origin"])).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    const pushUrls = (await this.gitFor(workspace, ["remote", "get-url", "--push", "--all", "origin"])).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    if (
      remotes.length !== 1 ||
      remotes[0] !== "origin" ||
      fetchUrls.length !== 1 ||
      fetchUrls[0] !== expectedUrl ||
      pushUrls.length !== 1 ||
      pushUrls[0] !== expectedUrl
    ) {
      throw new Error("vcs_remote_invalid");
    }
  }

  /**
   * Deliberately NOT windowed, unlike every other redaction caller: here
   * `redactTokenShapedValues` is a DETECTOR, not a formatter — nothing from the
   * config is ever emitted, only the fixed `vcs_git_config_unsafe` — so
   * redacting a prefix would narrow a security predicate over an
   * attacker-controlled file (a cloned repo's `.git/config`) to buy speed. The
   * input is already bounded: the size check short-circuits above it, so
   * redaction never sees more than 64 KiB, and with every pattern linear the
   * worst adversarial 64 KiB shape measures 22 ms (it was 1.5 s while the JWT
   * pattern was quadratic — that bug, not the breadth of this scan, was the
   * problem).
   */
  private async assertSafeLocalConfig(gitMetadataPath: string): Promise<void> {
    const config = await readFile(resolve(gitMetadataPath, "config"), "utf8");
    if (
      Buffer.byteLength(config, "utf8") > 64 * 1024 ||
      /^\s*\[(?:credential|filter\b|http\b|url\b)/im.test(config) ||
      /^\s*(?:extraheader|helper|insteadof|sshcommand|textconv|clean|smudge)\s*=/im.test(config) ||
      redactTokenShapedValues(config) !== config
    ) {
      throw new Error("vcs_git_config_unsafe");
    }
  }

  private async pushOnce(workspace: PreparedWorkspace, commitSha: string): Promise<void> {
    this.remote.assertPushRef?.(workspace.headRef);
    await this.remote.withAccess(workspace.repository, async (token) => {
      const auth = token !== undefined ? { authToken: token } : {};
      const remote = await this.remoteHead(workspace, auth);
      if (remote === commitSha) return;
      await this.remote.beforePush?.(workspace.repository, workspace.headRef);
      // A continuation's remote branch legitimately already sits at
      // baseCommit (that's the tip we cloned and committed on top of) --
      // that's the expected fast-forward pre-push state, not a conflict.
      // Any OTHER non-null value means something else moved the branch
      // since we cloned (a human push, a race), which is a real conflict.
      if (remote && remote !== workspace.baseCommit) throw this.remote.conflictError();
      try {
        await this.gitFor(
          workspace,
          [...this.remote.gitConfig, "push", "origin", `${commitSha}:refs/heads/${workspace.headRef}`],
          auth,
        );
      } catch (error) {
        const after = await this.remoteHead(workspace, auth);
        if (after === commitSha) return;
        // The branch moved between the check above and the push (to something
        // other than where we started or where we were going): report it as the
        // remote's conflict rather than the push's own (non-fast-forward)
        // failure. A remote still at baseCommit (a continuation) or still absent
        // means the push itself failed -- auth, a protected branch, a network
        // error, a rejecting hook -- so that error is the one to surface.
        if (after !== null && after !== workspace.baseCommit && after !== commitSha) {
          throw this.remote.conflictError();
        }
        throw error;
      }
    });
  }

  private async remoteHead(workspace: PreparedWorkspace, auth: { authToken?: string }): Promise<string | null> {
    const result = await this.gitFor(
      workspace,
      [...this.remote.gitConfig, "ls-remote", "--heads", "origin", `refs/heads/${workspace.headRef}`],
      auth,
    );
    const line = result.stdout.trim();
    if (!line) return null;
    const [sha, ref, ...rest] = line.split(/\s+/);
    if (rest.length > 0 || !SAFE_COMMIT_SHA.test(sha) || ref !== `refs/heads/${workspace.headRef}`) {
      throw new Error("vcs_remote_response_invalid");
    }
    return sha;
  }

  private async revParse(workspace: PreparedWorkspace, revision: string): Promise<string> {
    return this.revParseRaw(workspace.gitMetadataPath, workspace.workspacePath, revision);
  }

  private async revParseRaw(gitMetadataPath: string, workspacePath: string, revision: string): Promise<string> {
    const sha = (
      await this.gitForPaths(gitMetadataPath, workspacePath, ["rev-parse", "--verify", revision])
    ).stdout.trim();
    if (!SAFE_COMMIT_SHA.test(sha)) throw new Error("vcs_commit_sha_invalid");
    return sha;
  }

  private gitFor(
    workspace: PreparedWorkspace,
    args: readonly string[],
    options: Omit<GitCommandOptions, "cwd"> = {},
  ): Promise<GitCommandResult> {
    return this.gitForPaths(workspace.gitMetadataPath, workspace.workspacePath, args, options);
  }

  private gitForPaths(
    gitMetadataPath: string,
    workspacePath: string,
    args: readonly string[],
    options: Omit<GitCommandOptions, "cwd"> = {},
  ): Promise<GitCommandResult> {
    return this.git.run(
      [`--git-dir=${gitMetadataPath}`, `--work-tree=${workspacePath}`, ...HARDENED_GIT_CONFIG, ...args],
      { ...options, cwd: workspacePath },
    );
  }
}
