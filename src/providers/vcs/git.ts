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
import type { Dirent } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExcludePathspecs, isCollectExcluded, normalizeCollectExclusions } from "../../coding/collect-exclude.js";
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
import type { Readable, Writable } from "node:stream";
import {
  COMMIT_SHA,
  MAX_REDACTED_SPAN,
  isCodingRepositoryName,
  redactTokenShapedValues,
  normalizeGitRef,
} from "../../coding/protocol.js";
import type { RepositoryFileInput } from "./types.js";
import { isSafeGitAuthToken, type GitRemote } from "./remote.js";
import { buildWorkerGitDir } from "./worker-git.js";
import { RESULT_REF, importResultBundle, validateChangedPath } from "./result-history.js";
import type {
  ContinuationFinishedDetails,
  ContinuationOutcome,
  ContinuationTarget,
  DescriptionWriteOutcome,
  FinalizeChangesDetails,
  FinalizeChangesResult,
  GitHistorySetting,
  PreparedReadOnlyCopy,
  PreparedWorkspace,
  ReadOnlyCopyInput,
  RemoteLinkInput,
  TargetMerge,
  VcsPrepareInput,
  VcsProvider,
} from "./types.js";

export const DEFAULT_MAX_CHANGED_FILES = 1_000;
export const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 100_000;

/**
 * Walks every entry under `directory` (depth first, symlinks never followed),
 * calling `onEntry` for each; it returns whether to descend into the entry.
 * Shared by the workspace inspection and the run-wide entry count.
 */
async function walkEntries(
  directory: string,
  onEntry: (entry: Dirent, fullPath: string, directory: string) => Promise<boolean> | boolean,
): Promise<void> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const fullPath = resolve(directory, entry.name);
    if (await onEntry(entry, fullPath, directory)) await walkEntries(fullPath, onEntry);
  }
}

/**
 * The entry cap over several prepared repositories together (a run with
 * several): each one passed its own inspection, but the run's workspaces as a
 * whole may hold no more than `max` entries. Throws vcs_workspace_entry_limit.
 */
export async function countWorkspaceEntries(paths: readonly string[], max = MAX_WORKSPACE_ENTRIES): Promise<void> {
  let entries = 0;
  for (const path of paths) {
    await walkEntries(path, (entry) => {
      entries += 1;
      if (entries > max) throw new Error("vcs_workspace_entry_limit");
      return entry.isDirectory();
    });
  }
}
const SAFE_GIT_USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
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
/**
 * History runs (#536): the commit the worker's HEAD starts at, recorded at prepare time so recovery
 * reads it back -- baseCommit, or M0, the merge commit of a continuation's target-branch merge.
 */
const HISTORY_BASE_REF = "refs/wardby/history-base";
/** The most history a run may ask for (codingProfile.gitHistory.depth). */
const MAX_GIT_HISTORY_DEPTH = 100_000;
/** The label a remote's commit is filed under when its requested ref is not a branch or tag name. */
const PINNED_REMOTE_LABEL = "pinned";
/** How far `fetch --deepen` goes, step by step, looking for a merge base in a depth-1 clone. */
const MERGE_BASE_DEEPEN_STEPS = [64, 256, 1024, 4096] as const;
/** How many `--deepen` rounds restoreHeadDepth makes at most before it settles for what it has. */
const HEAD_DEPTH_RESTORE_ATTEMPTS = 4;
/** A conflict marker pair at the start of a line: git writes 7 characters (any longer run counts too), then a space or the line end. */
const CONFLICT_MARKER_START = /^<{7,}(?: |\r?$)/m;
const CONFLICT_MARKER_END = /^>{7,}(?: |\r?$)/m;
/**
 * A history run's finalize steps that read or write a tree the result bundle brought in (read-tree,
 * add, diff, write-tree, commit-tree): bounded, since that tree is the agent's.
 */
const TREE_STEP_TIMEOUT_MS = 300_000;

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
  /** The username git sends with the token (default: git-askpass.sh's GitHub default). Not secret. */
  authUsername?: string;
  maxOutputBytes?: number;
  /** Non-zero exit codes that still resolve with the output (`merge-tree` exits 1 on conflicts). */
  acceptExitCodes?: readonly number[];
  /**
   * Kills the command, and every process it started, after this many milliseconds, raising
   * GitCommandError `timed_out`. Unset: no limit.
   */
  timeoutMs?: number;
  /**
   * Written to the command's stdin: a string (`commit-tree -F -`), or a stream piped in (a result
   * bundle's pack, to `index-pack --stdin`); unset, stdin is closed. A stream that fails kills the command.
   */
  input?: string | Readable;
  /** Only the commit identity and date variables (GIT_COMMIT_ENV_NAMES); anything else is refused. */
  env?: Readonly<Partial<Record<GitCommitEnvName, string>>>;
}

/** The environment variables a caller may set for one git command: who made a commit, and when. */
export const GIT_COMMIT_ENV_NAMES = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
] as const;
export type GitCommitEnvName = (typeof GIT_COMMIT_ENV_NAMES)[number];
const GIT_COMMIT_ENV = new Set<string>(GIT_COMMIT_ENV_NAMES);

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
    if (options.authToken !== undefined && !isSafeGitAuthToken(options.authToken)) {
      throw new Error("git_auth_token_invalid");
    }
    if (options.authUsername !== undefined && !SAFE_GIT_USERNAME.test(options.authUsername)) {
      throw new Error("git_auth_username_invalid");
    }
    const commitEnv = Object.entries(options.env ?? {});
    if (
      commitEnv.some(([name, value]) => !GIT_COMMIT_ENV.has(name) || typeof value !== "string" || value.includes("\0"))
    ) {
      throw new Error("git_env_invalid");
    }
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("git_timeout_invalid");
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
      ...(options.authToken && options.authUsername ? { WARDBY_GIT_USERNAME: options.authUsername } : {}),
      SSH_ASKPASS: "/bin/false",
      GIT_LFS_SKIP_SMUDGE: "1",
      // WARDBY_TEST_SIMULATORS (test only): the simulator's throwaway CA; empty otherwise.
      ...simulatorGitEnvironment(),
      ...Object.fromEntries(commitEnv),
    };
    const maxBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
    const secrets = options.authToken ? [options.authToken] : [];

    return new Promise((resolvePromise, rejectPromise) => {
      const timed = options.timeoutMs !== undefined;
      const child = spawn(this.gitBinary, [...args], {
        cwd: options.cwd,
        env,
        shell: false,
        // A timed command leads its own process group, so a timeout kills what it started too
        // (fetch's index-pack, a shell's children), not just git.
        detached: timed,
        stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe", options.authToken ? "pipe" : "ignore"],
      });
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      if (!childStdout || !childStderr) {
        child.kill("SIGKILL");
        rejectPromise(new GitCommandError(null, "git_stdio_unavailable"));
        return;
      }
      let timedOut = false;
      const killAll = () => {
        try {
          if (timed && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const source = options.input;
      if (source !== undefined && child.stdin) {
        child.stdin.on("error", () => undefined);
        if (typeof source === "string") {
          child.stdin.end(source);
        } else {
          // A source that cannot be read must not look like a short, valid input.
          source.on("error", killAll);
          source.pipe(child.stdin);
          child.once("close", () => source.destroy());
        }
      }
      const timer = timed
        ? setTimeout(() => {
            timedOut = true;
            killAll();
            // Whatever still holds the pipes open is not waited for.
            childStdout.destroy();
            childStderr.destroy();
            rejectPromise(new GitCommandError(null, "timed_out"));
          }, options.timeoutMs)
        : undefined;
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
          killAll();
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
        if (timer) clearTimeout(timer);
        if (timedOut) return;
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

export { validateChangedPath };

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

const MAX_LOCAL_CONFIG_BYTES = 64 * 1024;

/** A repository config with no credential, transport, filter or token-shaped content (see assertSafeLocalConfig). */
function isSafeLocalConfig(config: string): boolean {
  return !(
    Buffer.byteLength(config, "utf8") > MAX_LOCAL_CONFIG_BYTES ||
    /^\s*\[(?:credential|filter\b|http\b|url\b)/im.test(config) ||
    /^\s*(?:extraheader|helper|insteadof|sshcommand|textconv|clean|smudge)\s*=/im.test(config) ||
    redactTokenShapedValues(config) !== config
  );
}

/** A value that is exactly one valid git ref component sequence, untouched by normalization. */
function isExactGitRef(value: string): boolean {
  return safeGitRef(value) === value;
}

/**
 * A remote's name (#536): a repository link name that is also one valid ref component, and never
 * `origin` (the default repository's own). Link creation checks this too; this is the backstop.
 */
function isRemoteName(name: string): boolean {
  return isCodingRepositoryName(name) && name !== "origin" && isExactGitRef(name) && !name.endsWith(".lock");
}

/** A remote's label as filed: the given branch or tag name when it is a valid ref below the remote's name, else "pinned". */
function remoteLabel(label: string): string {
  if (label === "HEAD" || label.startsWith("refs/") || !isExactGitRef(label)) return PINNED_REMOTE_LABEL;
  return label;
}

/** The clone (and fetch) depth arguments: depth 1 without history, the setting's depth, or none for full history. */
function depthArgs(gitHistory: GitHistorySetting | undefined): string[] {
  if (!gitHistory) return ["--depth", "1"];
  return gitHistory.depth === "full" ? [] : ["--depth", String(gitHistory.depth)];
}

function sameGitHistory(left: GitHistorySetting | undefined, right: GitHistorySetting | undefined): boolean {
  return left?.depth === right?.depth;
}

function sameRemotes(left: readonly RemoteLinkInput[] | undefined, right: readonly RemoteLinkInput[] | undefined) {
  const [a, b] = [left ?? [], right ?? []];
  return (
    a.length === b.length &&
    a.every(
      (remote, index) =>
        remote.name === b[index].name &&
        remote.repository === b[index].repository &&
        remote.resolvedSha === b[index].resolvedSha &&
        remote.label === b[index].label,
    )
  );
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

/** A workspace handle's id: `vcs-<runId>` for the default, `vcs-<runId>:<name>` for a slot. */
function workspaceId(workspace: { runId: string; slot?: { name: string } }): string {
  return `vcs-${workspace.runId}${workspace.slot ? `:${workspace.slot.name}` : ""}`;
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
    let paths: ReturnType<GitVcsProvider["expectedPaths"]>;
    try {
      paths = this.expectedPaths(normalized.runId, normalized.slot?.name);
    } catch (error) {
      throw new Error("vcs_workspace_path_invalid", { cause: error });
    }
    // A slot lives in the run directory the default workspace created, which must already exist.
    if (normalized.slot) await this.createSlotBase(paths);
    else await this.createBase(paths.base);
    // The directory this workspace owns: the run root for the default, repos/<name> for a slot.
    const base = paths.base;
    const { workspacePath, gitMetadataPath } = paths;
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
        const auth = this.gitAuth(token);
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
            { cwd: base, ...auth },
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
            // Without git history (#536) history is never needed: the worker
            // gets no Git metadata, the finalizer compares only against
            // baseCommit and the new commit's parent, and pushOnce compares
            // SHAs. Depth 1 keeps large repositories' history off the control
            // plane's disk. A history run clones to its depth, or in full.
            ...depthArgs(normalized.gitHistory),
            "--branch",
            cloneBranch,
            "--separate-git-dir",
            gitMetadataPath,
            cloneUrl,
            workspacePath,
          ],
          { cwd: base, ...auth },
        );
        if (mergeRef && mergeRef !== normalized.headRef) {
          mergeFetched = await this.fetchMergeTarget(
            gitMetadataPath,
            workspacePath,
            cloneBranch,
            mergeRef,
            auth,
            normalized.gitHistory,
          );
        }
      });
      for (const remote of normalized.remotes ?? []) {
        await this.fetchRemoteLink(gitMetadataPath, workspacePath, remote, normalized.gitHistory);
      }
      if (
        normalized.gitHistory &&
        normalized.gitHistory.depth !== "full" &&
        (normalized.remotes?.length || mergeFetched)
      ) {
        await this.restoreHeadDepth(gitMetadataPath, workspacePath, cloneBranch, normalized, mergeFetched);
      }
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
      // A history run's merge is committed now, as M0 (parents baseCommit and the target): the
      // worker starts at it, and its own commits are measured against it.
      const historyBase =
        normalized.gitHistory && merged
          ? await this.commitTwoParentMerge(
              { gitMetadataPath, workspacePath, baseCommit, headRef: normalized.headRef, runId: normalized.runId },
              merged.tree,
              merged.targetMerge,
            )
          : baseCommit;
      await this.gitForPaths(gitMetadataPath, workspacePath, [
        "read-tree",
        "--reset",
        "-u",
        merged?.tree ?? baseCommit,
      ]);
      if (normalized.gitHistory) {
        await this.gitForPaths(gitMetadataPath, workspacePath, ["update-ref", HISTORY_BASE_REF, historyBase]);
        await buildWorkerGitDir({
          git: this.git,
          gitMetadataPath,
          workspacePath,
          headRef: normalized.headRef,
          head: historyBase,
          remotes: (normalized.remotes ?? []).map((remote) => ({
            name: remote.name,
            label: remote.label,
            commit: remote.resolvedSha,
          })),
        });
      }
      await this.inspectWorkspace(workspacePath, { allowRootGit: Boolean(normalized.gitHistory) });

      return {
        id: workspaceId(normalized),
        ...normalized,
        baseCommit,
        workspacePath,
        gitMetadataPath,
        ...(merged ? { targetMerge: merged.targetMerge } : {}),
        ...(normalized.gitHistory
          ? { historyBase, remoteTips: (normalized.remotes ?? []).map((remote) => remote.resolvedSha) }
          : {}),
      };
    } catch (error) {
      // Never the run root for a slot: the default workspace (and any other slot) lives there.
      await rm(base, { recursive: true, force: true });
      throw error;
    }
  }

  async recoverWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace | null> {
    const normalized = this.validateInput(input);
    const expected = this.expectedPaths(normalized.runId, normalized.slot?.name);
    try {
      const metadata = await lstat(expected.base);
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
      id: workspaceId(normalized),
      ...normalized,
      baseCommit,
      workspacePath: expected.workspacePath,
      gitMetadataPath: expected.gitMetadataPath,
    };
    const history = normalized.gitHistory ? await this.readHistoryFields(normalized, expected) : undefined;
    const prepared = await this.validatePrepared({ ...recovered, ...history });
    await this.inspectWorkspace(prepared.workspacePath, { allowRootGit: Boolean(prepared.gitHistory) });
    await this.assertRemote(prepared);
    await this.assertSafeLocalConfig(prepared.gitMetadataPath);
    const symbolicHead = (await this.gitFor(prepared, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (symbolicHead !== prepared.headRef) throw new Error("vcs_head_ref_mismatch");
    const merge = await this.readMergeState(prepared);
    const currentHead = await this.revParse(prepared, "HEAD");
    // A history run's finalize records the tip it pushed (any number of commits on historyBase).
    const finalizedHistory = prepared.gitHistory !== undefined && currentHead === (await this.resultRef(prepared));
    if (currentHead !== prepared.baseCommit && !finalizedHistory) {
      const parent = await this.revParse(prepared, "HEAD^");
      if (parent !== prepared.baseCommit) throw new Error("vcs_commit_history_invalid");
      if (merge && (await this.revParse(prepared, "HEAD^2")) !== merge.targetCommit) {
        throw new Error("vcs_commit_history_invalid");
      }
    }
    if (prepared.historyBase !== undefined && prepared.historyBase !== prepared.baseCommit) {
      // M0: the recorded merge state's tree, on baseCommit and the target, and nothing else.
      if (!merge) throw new Error("vcs_commit_history_invalid");
      const parents = await this.commitParents(prepared, prepared.historyBase);
      const [mergeTree, stateTree] = await Promise.all([
        this.revParse(prepared, `${prepared.historyBase}^{tree}`),
        this.revParse(prepared, `${merge.stateCommit}^{tree}`),
      ]);
      if (
        parents.length !== 2 ||
        parents[0] !== prepared.baseCommit ||
        parents[1] !== merge.targetCommit ||
        mergeTree !== stateTree
      ) {
        throw new Error("vcs_commit_history_invalid");
      }
    }
    if (!merge) return prepared;
    const { stateCommit: _stateCommit, ...targetMerge } = merge;
    return { ...prepared, targetMerge };
  }

  /**
   * A history run's recorded fields, read back from the control plane's own git dir (never the
   * worker's): the history base, and each remote's tip, which must still be the commit dispatch
   * resolved.
   */
  private async readHistoryFields(
    normalized: Pick<PreparedWorkspace, "remotes">,
    paths: { gitMetadataPath: string; workspacePath: string },
  ): Promise<Pick<PreparedWorkspace, "historyBase" | "remoteTips">> {
    const historyBase = await this.revParseRaw(
      paths.gitMetadataPath,
      paths.workspacePath,
      `${HISTORY_BASE_REF}^{commit}`,
    ).catch((error: unknown) => {
      throw new Error("vcs_commit_history_invalid", { cause: error });
    });
    const remoteTips: string[] = [];
    for (const remote of normalized.remotes ?? []) {
      const tip = await this.revParseRaw(
        paths.gitMetadataPath,
        paths.workspacePath,
        `refs/remotes/${remote.name}/${remote.label}^{commit}`,
      );
      if (tip !== remote.resolvedSha) throw new Error("vcs_workspace_handle_invalid");
      remoteTips.push(tip);
    }
    return { historyBase, remoteTips };
  }

  /** A commit's parents, in order, from its raw object. */
  private async commitParents(workspace: PreparedWorkspace, commit: string): Promise<string[]> {
    const raw = (await this.gitFor(workspace, ["cat-file", "commit", commit])).stdout;
    const split = raw.indexOf("\n\n");
    const header = split < 0 ? raw : raw.slice(0, split);
    return header
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length));
  }

  async finalizeChanges(
    workspace: PreparedWorkspace,
    details?: FinalizeChangesDetails,
  ): Promise<FinalizeChangesResult> {
    const prepared = await this.validatePrepared(workspace);
    await this.inspectWorkspace(prepared.workspacePath, { allowRootGit: Boolean(prepared.gitHistory) });
    await this.assertRemote(prepared);
    await this.assertSafeLocalConfig(prepared.gitMetadataPath);
    // The merge state on disk is the trusted record; the handle must agree with it.
    const merge = await this.readMergeState(prepared);
    if (!sameTargetMerge(merge, prepared.targetMerge)) throw new Error("vcs_workspace_handle_invalid");
    if (prepared.gitHistory) return this.finalizeHistory(prepared, merge, details);
    // Only a history run's collector makes a result bundle.
    if (details?.resultBundle !== undefined) throw new Error("vcs_workspace_handle_invalid");
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
    return this.pushAndPublish(prepared, merge, details, changed, commitSha);
  }

  /** The end of every finalize that has something to push: push it once, then open or update the pull request (or report the branch). */
  private async pushAndPublish(
    prepared: PreparedWorkspace,
    merge: (TargetMerge & { stateCommit: string }) | undefined,
    details: FinalizeChangesDetails | undefined,
    changed: string[],
    commitSha: string,
  ): Promise<FinalizeChangesResult> {
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

  /**
   * A history run's finalize (#536). With a result bundle, the agent's commits are imported and
   * rewritten (result-history.ts) and become the start; without one, the start is historyBase
   * (baseCommit, or M0, a continuation's committed target merge, which is then pushed even with no
   * other change). The uncommitted files are staged on the start and committed on top as
   * "Wardby run <id>" when they differ from it. Every check runs over the agent's own changes: each
   * new commit's paths (against all its parents) and the uncommitted ones, together; the diff limit
   * over all their diffs together; the conflict-marker check over the target merge's conflicted paths
   * and every path a merge commit of the agent's resolved. refs/wardby/result records the tip pushed.
   */
  private async finalizeHistory(
    prepared: PreparedWorkspace,
    merge: (TargetMerge & { stateCommit: string }) | undefined,
    details: FinalizeChangesDetails | undefined,
  ): Promise<FinalizeChangesResult> {
    const historyBase = prepared.historyBase;
    if (historyBase === undefined) throw new Error("vcs_workspace_handle_invalid");
    const previousHead = await this.revParse(prepared, "HEAD");
    const finalized = await this.resultRef(prepared);
    if (details?.resultBundle === undefined && finalized !== null && finalized === previousHead) {
      return this.repushFinalized(prepared, merge, details, finalized);
    }
    const imported =
      details?.resultBundle !== undefined
        ? await importResultBundle({
            git: (args, options) => this.gitFor(prepared, args, options),
            bundlePath: details.resultBundle,
            historyBase,
            remoteTips: prepared.remoteTips ?? [],
            runId: prepared.runId,
            maxDiffBytes: this.maxDiffBytes,
            maxChangedFiles: this.maxChangedFiles,
          })
        : undefined;
    const exclusions = normalizeCollectExclusions(prepared.collectExclude);
    // A path no run ever collects (dependency and cache folders, the agent's collectExclude) is
    // never published from a commit either: the sandbox writes files there that are not the
    // agent's work, its package manager config with the run's registry token among them.
    if (imported?.agentPaths.some((path) => isCollectExcluded(path, exclusions))) {
      throw new Error("vcs_result_commit_unsafe");
    }
    const start = imported?.tip ?? historyBase;
    // The index starts at the start's tree, so excluded paths (never collected) keep the start's
    // version, and the staged diff is only what the agent left uncommitted.
    await this.gitFor(prepared, ["read-tree", start], { timeoutMs: TREE_STEP_TIMEOUT_MS });
    await this.gitFor(prepared, ["add", "--all", "--", ":/", ...gitExcludePathspecs(exclusions)], {
      timeoutMs: TREE_STEP_TIMEOUT_MS,
    });
    const staged = nullSeparated(
      (
        await this.gitFor(prepared, ["diff", "--cached", "--name-only", "-z", "--no-renames", start, "--"], {
          timeoutMs: TREE_STEP_TIMEOUT_MS,
        })
      ).stdout,
    );
    const changed = [...new Set([...(imported?.agentPaths ?? []).map(validateChangedPath), ...staged])];
    if (changed.length > this.maxChangedFiles) throw new Error("vcs_changed_file_limit");
    const protectedChange = changed.find(protectedPathMatcher(prepared.protectedPaths));
    if (protectedChange) throw new Error(`vcs_protected_path:${protectedChange}`);
    const remaining = this.maxDiffBytes - (imported?.agentDiffBytes ?? 0);
    if (remaining < 0) throw new Error("vcs_diff_size_limit");
    let diff: string;
    try {
      diff = (
        await this.gitFor(prepared, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", start, "--"], {
          maxOutputBytes: remaining,
          timeoutMs: TREE_STEP_TIMEOUT_MS,
        })
      ).stdout;
    } catch (error) {
      if (error instanceof GitCommandError && error.message.includes("git_output_limit")) {
        throw new Error("vcs_diff_size_limit", { cause: error });
      }
      throw error;
    }
    if (Buffer.byteLength(diff, "utf8") > remaining) throw new Error("vcs_diff_size_limit");
    // After the size limits, as for a run without history. The workspace holds the final tree.
    const conflicted = [...new Set([...(merge?.conflictedPaths ?? []), ...(imported?.mergePaths ?? [])])];
    if (conflicted.length > 0) await this.assertConflictsResolved(prepared.workspacePath, conflicted);

    const tree = (await this.gitFor(prepared, ["write-tree"], { timeoutMs: TREE_STEP_TIMEOUT_MS })).stdout.trim();
    if (!COMMIT_SHA.test(tree)) throw new Error("vcs_commit_sha_invalid");
    let commitSha: string;
    if (tree === (await this.revParse(prepared, `${start}^{tree}`))) {
      commitSha = start;
    } else if (
      previousHead !== start &&
      (await this.commitParents(prepared, previousHead)).join(" ") === start &&
      (await this.revParse(prepared, `${previousHead}^{tree}`)) === tree
    ) {
      // Finalized before with these same files: the commit already made is pushed again.
      commitSha = previousHead;
    } else {
      commitSha = (
        await this.gitFor(prepared, ["commit-tree", tree, "-p", start, "-m", `Wardby run ${prepared.runId}`], {
          timeoutMs: TREE_STEP_TIMEOUT_MS,
        })
      ).stdout.trim();
      if (!COMMIT_SHA.test(commitSha)) throw new Error("vcs_commit_sha_invalid");
    }
    if (commitSha === prepared.baseCommit) {
      return {
        outcome: "no_changes",
        repository: prepared.repository,
        baseRef: prepared.baseRef,
        baseCommit: prepared.baseCommit,
      };
    }
    const symbolicHead = (await this.gitFor(prepared, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (symbolicHead !== prepared.headRef) throw new Error("vcs_head_ref_mismatch");
    await this.gitFor(prepared, ["update-ref", `refs/heads/${prepared.headRef}`, commitSha]);
    await this.gitFor(prepared, ["symbolic-ref", "HEAD", `refs/heads/${prepared.headRef}`]);
    await this.gitFor(prepared, ["update-ref", RESULT_REF, commitSha]);
    return this.pushAndPublish(prepared, merge, details, changed, commitSha);
  }

  /**
   * A history run finalized before (refs/wardby/result is HEAD: every check passed then) and finalized
   * again without a bundle: the same tip is pushed again, provided the collected files still match it.
   */
  private async repushFinalized(
    prepared: PreparedWorkspace,
    merge: (TargetMerge & { stateCommit: string }) | undefined,
    details: FinalizeChangesDetails | undefined,
    commitSha: string,
  ): Promise<FinalizeChangesResult> {
    await this.gitFor(prepared, ["read-tree", commitSha], { timeoutMs: TREE_STEP_TIMEOUT_MS });
    await this.gitFor(
      prepared,
      ["add", "--all", "--", ":/", ...gitExcludePathspecs(normalizeCollectExclusions(prepared.collectExclude))],
      { timeoutMs: TREE_STEP_TIMEOUT_MS },
    );
    const afterCommitChanges = nullSeparated(
      (
        await this.gitFor(prepared, ["diff", "--cached", "--name-only", "-z", commitSha, "--"], {
          timeoutMs: TREE_STEP_TIMEOUT_MS,
        })
      ).stdout,
    );
    if (afterCommitChanges.length > 0) throw new Error("vcs_finalized_workspace_changed");
    // Only for the pull request's notes (lockfiles): what the branch changes against where it started.
    const changed = await this.gitFor(
      prepared,
      ["diff", "--name-only", "-z", "--no-renames", prepared.baseCommit, commitSha, "--"],
      { timeoutMs: TREE_STEP_TIMEOUT_MS },
    ).then(
      (result) => nullSeparated(result.stdout).slice(0, this.maxChangedFiles),
      () => [],
    );
    const symbolicHead = (await this.gitFor(prepared, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (symbolicHead !== prepared.headRef) throw new Error("vcs_head_ref_mismatch");
    return this.pushAndPublish(prepared, merge, details, changed, commitSha);
  }

  /** refs/wardby/result in the control plane's git dir, or null when no finalize recorded one. */
  private async resultRef(workspace: PreparedWorkspace): Promise<string | null> {
    const value = (await this.gitFor(workspace, ["for-each-ref", "--format=%(objectname)", RESULT_REF])).stdout.trim();
    if (!value) return null;
    if (!COMMIT_SHA.test(value)) throw new Error("vcs_commit_sha_invalid");
    return value;
  }

  /** The two-parent merge commit (baseCommit, the target) of the staged tree, as the Wardby identity. */
  private async commitMerge(prepared: PreparedWorkspace, merge: TargetMerge): Promise<string> {
    const tree = (await this.gitFor(prepared, ["write-tree"])).stdout.trim();
    if (!COMMIT_SHA.test(tree)) throw new Error("vcs_commit_sha_invalid");
    return this.commitTwoParentMerge(prepared, tree, merge);
  }

  /**
   * Commits `tree` with the parents baseCommit and the target's commit, as the Wardby identity, and
   * moves headRef from baseCommit to it: the merge a finalize commits, and a history run's M0 (#536).
   */
  private async commitTwoParentMerge(
    workspace: Pick<PreparedWorkspace, "gitMetadataPath" | "workspacePath" | "baseCommit" | "headRef" | "runId">,
    tree: string,
    merge: Pick<TargetMerge, "ref" | "targetCommit">,
  ): Promise<string> {
    const { gitMetadataPath, workspacePath } = workspace;
    const commitSha = (
      await this.gitForPaths(gitMetadataPath, workspacePath, [
        "commit-tree",
        tree,
        "-p",
        workspace.baseCommit,
        "-p",
        merge.targetCommit,
        "-m",
        `Merge ${merge.ref} into ${workspace.headRef} (Wardby run ${workspace.runId})`,
      ])
    ).stdout.trim();
    if (!COMMIT_SHA.test(commitSha)) throw new Error("vcs_commit_sha_invalid");
    await this.gitForPaths(gitMetadataPath, workspacePath, [
      "update-ref",
      `refs/heads/${workspace.headRef}`,
      commitSha,
      workspace.baseCommit,
    ]);
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

  /** Removes the workspace's own directory: the run root for the default (slots included), repos/<name> for a slot. */
  async cleanup(workspace: PreparedWorkspace): Promise<void> {
    const expected = this.expectedPaths(workspace.runId, workspace.slot?.name);
    if (
      workspace.id !== workspaceId(workspace) ||
      workspace.workspacePath !== expected.workspacePath ||
      workspace.gitMetadataPath !== expected.gitMetadataPath
    ) {
      throw new Error("vcs_workspace_handle_invalid");
    }
    await rm(expected.base, { recursive: true, force: true });
  }

  /**
   * One commit's files at `<run>/repos/<name>/workspace`, for the run to read.
   * The commit is fetched into a temporary git directory beside the copy
   * (never inside it), checked out, and the git directory deleted, so the
   * copy holds no git metadata at all; it is inspected like a workspace
   * (no nested repository, no escaping symlink) and nothing in it is ever
   * collected. The run's default workspace must already exist.
   */
  async prepareReadOnlyCopy(input: ReadOnlyCopyInput): Promise<PreparedReadOnlyCopy> {
    if (!SAFE_RUN_ID.test(input.runId) || !isCodingRepositoryName(input.name) || !COMMIT_SHA.test(input.commit)) {
      throw new Error("vcs_read_only_input_invalid");
    }
    const repository = this.remote.normalizeRepository(input.repository);
    const paths = this.expectedPaths(input.runId, input.name);
    await this.createSlotBase(paths);
    const temporaryGit = resolve(paths.base, ".git-fetch");
    try {
      await mkdir(paths.workspacePath, { mode: 0o700 });
      await this.gitForPaths(temporaryGit, paths.workspacePath, ["init", "--quiet"]);
      const fetchCommit = async (token: string | undefined) => {
        try {
          await this.gitForPaths(
            temporaryGit,
            paths.workspacePath,
            [
              ...this.remote.gitConfig,
              "fetch",
              "--no-tags",
              "--no-write-fetch-head",
              "--depth",
              "1",
              this.remote.cloneUrl(repository),
              input.commit,
            ],
            this.gitAuth(token),
          );
        } catch (error) {
          throw new Error("vcs_read_only_fetch_failed", { cause: error });
        }
      };
      // Read access where the remote has it (GitHub: contents read, or none for a public repository).
      if (this.remote.withReadAccess) await this.remote.withReadAccess(repository, fetchCommit);
      else await this.remote.withAccess(repository, fetchCommit);
      // Only a commit is checked out (never a bare tree or blob someone passed as a SHA).
      if ((await this.revParseRaw(temporaryGit, paths.workspacePath, `${input.commit}^{commit}`)) !== input.commit) {
        throw new Error("vcs_read_only_fetch_failed");
      }
      await this.gitForPaths(temporaryGit, paths.workspacePath, ["read-tree", "--reset", "-u", input.commit]);
      await rm(temporaryGit, { recursive: true, force: true });
      await this.inspectWorkspace(paths.workspacePath);
      return {
        runId: input.runId,
        name: input.name,
        repository,
        commit: input.commit,
        workspacePath: paths.workspacePath,
      };
    } catch (error) {
      await rm(paths.base, { recursive: true, force: true });
      throw error;
    }
  }

  async cleanupReadOnlyCopy(copy: PreparedReadOnlyCopy): Promise<void> {
    const paths = this.expectedPaths(copy.runId, copy.name);
    if (copy.workspacePath !== paths.workspacePath) throw new Error("vcs_workspace_handle_invalid");
    await rm(paths.base, { recursive: true, force: true });
  }

  /** The default workspace's run root, created fresh (vcs_workspace_exists when it is already there). */
  private async createBase(base: string): Promise<void> {
    try {
      await mkdir(base, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("vcs_workspace_exists", { cause: error });
      throw error;
    }
  }

  /**
   * An extra repository's own directory, repos/<name>, created fresh inside
   * the existing run root. The run root and repos/ must be real directories
   * (never symlinks), so nothing is created outside the root directory.
   */
  private async createSlotBase(paths: { runRoot: string; base: string }): Promise<void> {
    const runRootStat = await lstat(paths.runRoot).catch(() => null);
    if (!runRootStat?.isDirectory() || runRootStat.isSymbolicLink()) throw new Error("vcs_workspace_path_invalid");
    const repos = resolve(paths.runRoot, "repos");
    await mkdir(repos, { recursive: true, mode: 0o700 });
    const reposStat = await lstat(repos);
    if (!reposStat.isDirectory() || reposStat.isSymbolicLink()) throw new Error("vcs_workspace_path_invalid");
    await this.createBase(paths.base);
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

  async resolveRef(input: { repository: string; ref: string; access: "read" | "write" }): Promise<string | null> {
    if (!this.remote.resolveCommit) throw new Error("vcs_resolve_ref_unsupported");
    return this.remote.resolveCommit(this.remote.normalizeRepository(input.repository), input.ref, input.access);
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
    // branchRunId: a writable extra whose branch is named for another run (a
    // continuation's root) but does not exist yet, so it is created off
    // baseRef like a fresh run's; dispatch chose it, this checks only its shape.
    let continuation: { rootRunId: string } | undefined;
    if (input.continuation) {
      if (!SAFE_RUN_ID.test(input.continuation.rootRunId)) throw new Error("vcs_root_run_id_invalid");
      continuation = { rootRunId: input.continuation.rootRunId };
    }
    if (input.branchRunId !== undefined && !SAFE_RUN_ID.test(input.branchRunId)) {
      throw new Error("vcs_branch_run_id_invalid");
    }
    if (continuation && input.branchRunId !== undefined && input.branchRunId !== continuation.rootRunId) {
      throw new Error("vcs_head_ref_invalid");
    }
    if (headRef !== `wardby/run-${continuation?.rootRunId ?? input.branchRunId ?? input.runId}`) {
      throw new Error("vcs_head_ref_invalid");
    }
    if (input.slot !== undefined && !isCodingRepositoryName(input.slot.name)) throw new Error("vcs_slot_invalid");
    const protectedPaths = [...new Set(input.protectedPaths.map(validateProtectedPath))];
    if (protectedPaths.length === 0 || protectedPaths.length > 128) throw new Error("vcs_protected_paths_invalid");
    if (!protectsSomePath(protectedPaths)) throw new Error("vcs_protected_paths_invalid");
    const collectExclude = [...normalizeCollectExclusions(input.collectExclude ?? []).paths];
    let gitHistory: GitHistorySetting | undefined;
    if (input.gitHistory !== undefined) {
      const { depth } = input.gitHistory;
      if (depth !== "full" && !(Number.isSafeInteger(depth) && depth >= 1 && depth <= MAX_GIT_HISTORY_DEPTH)) {
        throw new Error("vcs_git_history_invalid");
      }
      gitHistory = { depth };
    }
    let remotes: RemoteLinkInput[] | undefined;
    if (input.remotes !== undefined && input.remotes.length > 0) {
      // Dispatch refuses these first (repository_remote_needs_history / _invalid); this is the backstop.
      if (!gitHistory) throw new Error("repository_remote_needs_history");
      if (input.slot !== undefined) throw new Error("repository_remote_invalid");
      const names = new Set<string>();
      remotes = input.remotes.map((remote) => {
        if (!isRemoteName(remote.name) || names.has(remote.name) || !COMMIT_SHA.test(remote.resolvedSha)) {
          throw new Error("repository_remote_invalid");
        }
        names.add(remote.name);
        return {
          name: remote.name,
          repository: this.remote.normalizeRepository(remote.repository),
          resolvedSha: remote.resolvedSha,
          label: remoteLabel(remote.label),
        };
      });
    }
    return {
      runId: input.runId,
      repository,
      baseRef,
      headRef,
      protectedPaths,
      collectExclude,
      continuation,
      ...(input.slot ? { slot: { name: input.slot.name } } : {}),
      ...(input.branchRunId !== undefined ? { branchRunId: input.branchRunId } : {}),
      ...(gitHistory ? { gitHistory } : {}),
      ...(remotes ? { remotes } : {}),
    };
  }

  /** The default is `<root>/<runId>/{workspace,git}`; a slot (or read-only copy) is `<root>/<runId>/repos/<name>/…`. */
  private expectedPaths(
    runId: string,
    slot?: string,
  ): { runRoot: string; base: string; workspacePath: string; gitMetadataPath: string } {
    if (!SAFE_RUN_ID.test(runId)) throw new Error("vcs_workspace_handle_invalid");
    if (slot !== undefined && !isCodingRepositoryName(slot)) throw new Error("vcs_workspace_handle_invalid");
    const runRoot = resolve(this.rootDir, runId);
    if (!directChild(this.rootDir, runRoot)) throw new Error("vcs_workspace_handle_invalid");
    const base = slot === undefined ? runRoot : resolve(runRoot, "repos", slot);
    return {
      runRoot,
      base,
      workspacePath: resolve(base, "workspace"),
      gitMetadataPath: resolve(base, "git"),
    };
  }

  private async validatePrepared(workspace: PreparedWorkspace): Promise<PreparedWorkspace> {
    const normalized = this.validateInput(workspace);
    const expected = this.expectedPaths(normalized.runId, normalized.slot?.name);
    if (
      workspace.id !== workspaceId(normalized) ||
      !COMMIT_SHA.test(workspace.baseCommit) ||
      workspace.repository !== normalized.repository ||
      workspace.baseRef !== normalized.baseRef ||
      workspace.headRef !== normalized.headRef ||
      workspace.workspacePath !== expected.workspacePath ||
      workspace.gitMetadataPath !== expected.gitMetadataPath ||
      workspace.protectedPaths.length !== normalized.protectedPaths.length ||
      workspace.protectedPaths.some((path, index) => path !== normalized.protectedPaths[index]) ||
      workspace.collectExclude.length !== normalized.collectExclude.length ||
      workspace.collectExclude.some((path, index) => path !== normalized.collectExclude[index]) ||
      workspace.continuation?.rootRunId !== normalized.continuation?.rootRunId ||
      !sameGitHistory(workspace.gitHistory, normalized.gitHistory) ||
      !sameRemotes(workspace.remotes, normalized.remotes) ||
      !this.validHistoryFields(workspace, normalized)
    ) {
      throw new Error("vcs_workspace_handle_invalid");
    }
    const [rootReal, baseReal, workspaceReal, metadataReal] = await Promise.all([
      realpath(this.rootDir),
      realpath(expected.base),
      realpath(expected.workspacePath),
      realpath(expected.gitMetadataPath),
    ]);
    const expectedBase = normalized.slot
      ? resolve(rootReal, workspace.runId, "repos", normalized.slot.name)
      : resolve(rootReal, workspace.runId);
    if (
      baseReal !== expectedBase ||
      workspaceReal !== resolve(baseReal, "workspace") ||
      metadataReal !== resolve(baseReal, "git")
    ) {
      throw new Error("vcs_workspace_path_invalid");
    }
    return { ...workspace, ...normalized };
  }

  /** A history run's historyBase and remoteTips are set and well formed; no other run has either. */
  private validHistoryFields(
    workspace: PreparedWorkspace,
    normalized: Pick<PreparedWorkspace, "gitHistory" | "remotes">,
  ): boolean {
    if (!normalized.gitHistory) return workspace.historyBase === undefined && workspace.remoteTips === undefined;
    const tips = (normalized.remotes ?? []).map((remote) => remote.resolvedSha);
    return (
      workspace.historyBase !== undefined &&
      COMMIT_SHA.test(workspace.historyBase) &&
      workspace.remoteTips !== undefined &&
      workspace.remoteTips.length === tips.length &&
      workspace.remoteTips.every((tip, index) => tip === tips[index])
    );
  }

  /**
   * Fetches one remote link's resolved commit (#536) into the control plane's git dir at
   * `refs/remotes/<name>/<label>`, to the run's history depth (or in full), under the remote's read
   * access. Any failure is vcs_remote_fetch_failed:<name>, its git output redacted by the token.
   */
  private async fetchRemoteLink(
    gitMetadataPath: string,
    workspacePath: string,
    remote: RemoteLinkInput,
    gitHistory: GitHistorySetting | undefined,
  ): Promise<void> {
    const ref = `refs/remotes/${remote.name}/${remote.label}`;
    const url = this.remote.cloneUrl(remote.repository);
    const fetch = async (token: string | undefined) => {
      try {
        await this.gitForPaths(
          gitMetadataPath,
          workspacePath,
          [
            ...this.remote.gitConfig,
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            ...depthArgs(gitHistory),
            url,
            `${remote.resolvedSha}:${ref}`,
          ],
          this.gitAuth(token),
        );
        if ((await this.revParseRaw(gitMetadataPath, workspacePath, `${ref}^{commit}`)) !== remote.resolvedSha) {
          throw new Error("vcs_remote_commit_mismatch");
        }
      } catch (error) {
        // Only the redacted text goes on: the raw error (and its chain) never leaves here, so a
        // runner that did not redact its own output cannot carry the token out either.
        const detail = redactGitOutput(error instanceof Error ? error.message : "unknown", token ? [token] : []);
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`vcs_remote_fetch_failed:${remote.name}`, { cause: new Error(detail) });
      }
    };
    if (this.remote.withReadAccess) await this.remote.withReadAccess(remote.repository, fetch);
    else await this.remote.withAccess(remote.repository, fetch);
  }

  /**
   * Git's shallow boundary is shared by the whole repository: a depth-n fetch of a remote (or of a
   * continuation's target) whose tip is nearer the shared merge base than n can mark the head's own
   * commits shallow, leaving the head with less history than configured.
   *
   * This only ever adds history. When the head already has at least n commits (for instance after
   * fetchMergeTarget deepened it to reach a merge base) nothing is fetched. Otherwise it deepens by
   * the missing count (`--deepen`, which moves the boundary back and never forward), a few bounded
   * times while the head still stops at a shallow commit. It then checks that every remote link and
   * the merge target kept at least the history they had, and that a merge base found before is
   * still there. (A `--depth n` fetch would instead reset the boundary and could shorten all of them.)
   *
   * It fetches the recorded baseCommit SHA (never the branch name), into a scratch ref under
   * refs/wardby, so a branch that moved on the host meanwhile cannot move refs/remotes/origin/<branch>
   * or baseCommit. (Fetching a SHA is what the remote links already do.)
   */
  private async restoreHeadDepth(
    gitMetadataPath: string,
    workspacePath: string,
    cloneBranch: string,
    input: { repository: string; gitHistory?: GitHistorySetting; remotes?: readonly RemoteLinkInput[] },
    mergeFetched: boolean,
  ): Promise<void> {
    const depth = input.gitHistory?.depth;
    if (typeof depth !== "number") return;
    const git = (args: readonly string[], options: { acceptExitCodes?: number[] } = {}) =>
      this.gitForPaths(gitMetadataPath, workspacePath, [...args], options);
    const count = async (revision: string) => Number((await git(["rev-list", "--count", revision])).stdout.trim());
    const mergeBase = async (a: string, b: string) =>
      (await git(["merge-base", a, b], { acceptExitCodes: [1] })).stdout.trim();
    const sha = await this.revParseRaw(gitMetadataPath, workspacePath, `refs/remotes/origin/${cloneBranch}^{commit}`);
    let have = await count(sha);
    if (have >= depth) return;
    const others = [
      ...(input.remotes ?? []).map((remote) => `refs/remotes/${remote.name}/${remote.label}`),
      ...(mergeFetched ? [MERGE_TARGET_REF] : []),
    ];
    const before = await Promise.all(others.map(count));
    const baseBefore = mergeFetched ? await mergeBase(sha, MERGE_TARGET_REF) : "";
    await this.remote.withAccess(input.repository, async (token) => {
      try {
        for (let attempt = 0; attempt < HEAD_DEPTH_RESTORE_ATTEMPTS && have < depth; attempt += 1) {
          if (!(await this.stopsAtShallowBoundary(gitMetadataPath, workspacePath, sha))) break;
          await this.gitForPaths(
            gitMetadataPath,
            workspacePath,
            [
              ...this.remote.gitConfig,
              "fetch",
              "--no-tags",
              "--no-write-fetch-head",
              `--deepen=${depth - have}`,
              "origin",
              `+${sha}:${MERGE_HEAD_REF}`,
            ],
            this.gitAuth(token),
          );
          if ((await this.revParseRaw(gitMetadataPath, workspacePath, `${MERGE_HEAD_REF}^{commit}`)) !== sha) {
            throw new Error("vcs_head_commit_mismatch");
          }
          have = await count(sha);
        }
        const after = await Promise.all(others.map(count));
        if (after.some((value, index) => value < before[index])) throw new Error("vcs_history_shortened");
        if (baseBefore && !(await mergeBase(sha, MERGE_TARGET_REF))) throw new Error("vcs_history_shortened");
      } catch (error) {
        // Redacted text only; the raw error chain never leaves here.
        const detail = redactGitOutput(error instanceof Error ? error.message : "unknown", token ? [token] : []);
        // eslint-disable-next-line preserve-caught-error
        throw new Error("vcs_remote_fetch_failed:origin", { cause: new Error(detail) });
      }
    });
  }

  /** Whether `commit`'s history ends at a shallow commit (rather than at a real root). */
  private async stopsAtShallowBoundary(
    gitMetadataPath: string,
    workspacePath: string,
    commit: string,
  ): Promise<boolean> {
    let shallow: string;
    try {
      shallow = await readFile(resolve(gitMetadataPath, "shallow"), "utf8");
    } catch {
      return false;
    }
    const boundary = new Set(shallow.split("\n").filter(Boolean));
    if (boundary.size === 0) return false;
    const roots = (
      await this.gitForPaths(gitMetadataPath, workspacePath, ["rev-list", "--max-parents=0", commit])
    ).stdout
      .split("\n")
      .filter(Boolean);
    return roots.some((root) => boundary.has(root));
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
    auth: { authToken?: string; authUsername?: string },
    gitHistory?: GitHistorySetting,
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
      // The target comes at the clone's own depth: 1, a history run's depth, or in full (#536).
      await fetch(depthArgs(gitHistory), target);
      // A full clone has nothing to deepen: a merge base is there at once, or not at all.
      const steps = gitHistory?.depth === "full" ? [] : MERGE_BASE_DEEPEN_STEPS;
      for (const step of [0, ...steps]) {
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
    if (!COMMIT_SHA.test(tree)) throw new Error("vcs_target_merge_failed");
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
      if (!COMMIT_SHA.test(stateCommit)) throw new Error("vcs_commit_sha_invalid");
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
    if (!COMMIT_SHA.test(stateCommit)) throw new Error("vcs_merge_state_invalid");
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
      !COMMIT_SHA.test(parents[1]) ||
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

  /**
   * `allowRootGit` (history runs, #536): the workspace root's own `.git` directory is allowed. It is
   * never walked and never run git against (the worker can write it); only its config is read, as
   * text, and must pass the local-config checks. Any other `.git` is a nested repository.
   */
  private async inspectWorkspace(workspacePath: string, options: { allowRootGit?: boolean } = {}): Promise<void> {
    const rootStat = await lstat(workspacePath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("vcs_workspace_path_invalid");
    let entries = 0;
    await walkEntries(workspacePath, async (entry, fullPath, directory) => {
      entries += 1;
      if (entries > MAX_WORKSPACE_ENTRIES) throw new Error("vcs_workspace_entry_limit");
      if (entry.name.toLowerCase() === ".git") {
        if (!options.allowRootGit || entry.name !== ".git" || directory !== workspacePath) {
          throw new Error("vcs_nested_repository");
        }
        await this.assertSafeWorkerGit(fullPath);
        return false;
      }
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
        return false;
      }
      if (stat.isDirectory()) return true;
      if (!stat.isFile()) throw new Error("vcs_special_file");
      return false;
    });
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
    if (!isSafeLocalConfig(config)) throw new Error("vcs_git_config_unsafe");
  }

  /**
   * The worker's `.git` (#536), which the worker can write: a real directory (not a symlink, not a
   * gitdir file), whose config is a regular file read without following a symlink, at most 64 KiB,
   * passing the same checks as the control plane's own. Anything else is vcs_git_config_unsafe.
   */
  private async assertSafeWorkerGit(gitDir: string): Promise<void> {
    const stat = await lstat(gitDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("vcs_nested_repository");
    let handle: FileHandle;
    try {
      handle = await open(resolve(gitDir, "config"), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      throw new Error("vcs_git_config_unsafe", { cause: error });
    }
    let config: string;
    try {
      const configStat = await handle.stat();
      if (!configStat.isFile() || configStat.size > MAX_LOCAL_CONFIG_BYTES) throw new Error("vcs_git_config_unsafe");
      const buffer = Buffer.alloc(MAX_LOCAL_CONFIG_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_LOCAL_CONFIG_BYTES) throw new Error("vcs_git_config_unsafe");
      config = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    if (!isSafeLocalConfig(config)) throw new Error("vcs_git_config_unsafe");
  }

  /** The git credentials for a remote's access token; none when the remote needs no token. */
  private gitAuth(token: string | undefined): { authToken?: string; authUsername?: string } {
    if (token === undefined) return {};
    return { authToken: token, ...(this.remote.gitUsername ? { authUsername: this.remote.gitUsername } : {}) };
  }

  private async pushOnce(workspace: PreparedWorkspace, commitSha: string): Promise<void> {
    this.remote.assertPushRef?.(workspace.headRef);
    await this.remote.withAccess(workspace.repository, async (token) => {
      const auth = this.gitAuth(token);
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

  private async remoteHead(
    workspace: PreparedWorkspace,
    auth: { authToken?: string; authUsername?: string },
  ): Promise<string | null> {
    const result = await this.gitFor(
      workspace,
      [...this.remote.gitConfig, "ls-remote", "--heads", "origin", `refs/heads/${workspace.headRef}`],
      auth,
    );
    const line = result.stdout.trim();
    if (!line) return null;
    const [sha, ref, ...rest] = line.split(/\s+/);
    if (rest.length > 0 || !COMMIT_SHA.test(sha) || ref !== `refs/heads/${workspace.headRef}`) {
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
    if (!COMMIT_SHA.test(sha)) throw new Error("vcs_commit_sha_invalid");
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
