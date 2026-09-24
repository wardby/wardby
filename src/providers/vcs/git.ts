import { spawn } from "node:child_process";
import { lstat, mkdir, opendir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory } from "../../core/private-directory.js";
import type { Writable } from "node:stream";
import {
  MAX_REDACTED_SPAN,
  redactTokenShapedValues,
  normalizeGitHubRepository,
  normalizeGitRef,
} from "../../coding/protocol.js";
import { isSafeGitHubInstallationToken, type GitHubRepositoryAccess } from "./github.js";
import type {
  FinalizeChangesDetails,
  FinalizeChangesResult,
  PreparedWorkspace,
  VcsPrepareInput,
  VcsProvider,
} from "./types.js";

export const DEFAULT_MAX_CHANGED_FILES = 1_000;
export const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 100_000;
const SAFE_COMMIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
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
  let output = value.slice(0, GIT_OUTPUT_DISPLAY_BYTES + MAX_REDACTED_SPAN);
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
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
        if (code !== 0) {
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
  github: GitHubRepositoryAccess;
  git?: GitCommandRunner;
  maxChangedFiles?: number;
  maxDiffBytes?: number;
  /** Test-only transport override; production composition always uses github.com. */
  cloneUrlForRepository?: (repository: string) => string;
}

function validateProtectedPath(value: string): string {
  const path = value.trim();
  if (
    !path ||
    Buffer.byteLength(path, "utf8") > 512 ||
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("vcs_protected_path_invalid");
  }
  return path;
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function validateChangedPath(path: string): string {
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

function directChild(root: string, child: string): boolean {
  return child.startsWith(`${root}${sep}`) && !child.slice(root.length + 1).includes(sep);
}

/** Human-readable label for continuation status notifications -- falls back to the opaque run id alone when no agent name is known. */
function runLabel(agentName: string | undefined, runId: string): string {
  return agentName ? `${agentName} (wardby run ${runId})` : `wardby run ${runId}`;
}

export class GitVcsProvider implements VcsProvider {
  private readonly rootDir: string;
  private readonly git: GitCommandRunner;
  private readonly maxChangedFiles: number;
  private readonly maxDiffBytes: number;
  private readonly cloneUrlForRepository: (repository: string) => string;

  constructor(private readonly options: GitVcsProviderOptions) {
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
    this.cloneUrlForRepository =
      options.cloneUrlForRepository ?? ((repository) => `https://github.com/${repository}.git`);
  }

  async prepareWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace> {
    const normalized = this.validateInput(input);
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
    const cloneUrl = this.cloneUrlForRepository(normalized.repository);
    if (!this.options.cloneUrlForRepository && cloneUrl !== `https://github.com/${normalized.repository}.git`) {
      throw new Error("vcs_remote_invalid");
    }
    // Revision-in-place: a continuation clones the EXISTING headRef branch
    // directly (its current tip becomes baseCommit below) instead of
    // baseRef -- everything after this line (branch/checkout/reset, and
    // every check in finalizeChanges) is unchanged either way, since
    // baseCommit already means exactly what it needs to: "where this
    // round started."
    const cloneBranch = normalized.continuation ? normalized.headRef : normalized.baseRef;

    try {
      await this.options.github.withRepositoryToken(normalized.repository, async (token) => {
        await this.git.run(
          [
            ...HARDENED_GIT_CONFIG,
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
          { cwd: runRoot, authToken: token },
        );
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
      await this.gitForPaths(gitMetadataPath, workspacePath, ["read-tree", "--reset", "-u", baseCommit]);
      await this.inspectWorkspace(workspacePath);

      return {
        id: `vcs-${normalized.runId}`,
        ...normalized,
        baseCommit,
        workspacePath,
        gitMetadataPath,
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
    const currentHead = await this.revParse(prepared, "HEAD");
    if (currentHead !== prepared.baseCommit) {
      const parent = await this.revParse(prepared, "HEAD^");
      if (parent !== prepared.baseCommit) throw new Error("vcs_commit_history_invalid");
    }
    return prepared;
  }

  async finalizeChanges(
    workspace: PreparedWorkspace,
    details?: FinalizeChangesDetails,
  ): Promise<FinalizeChangesResult> {
    const prepared = await this.validatePrepared(workspace);
    await this.inspectWorkspace(prepared.workspacePath);
    await this.assertRemote(prepared);
    await this.assertSafeLocalConfig(prepared.gitMetadataPath);
    await this.gitFor(prepared, ["add", "--all", "--", ":/"]);
    const changed = nullSeparated(
      (
        await this.gitFor(prepared, [
          "diff",
          "--cached",
          "--name-only",
          "-z",
          "--no-renames",
          prepared.baseCommit,
          "--",
        ])
      ).stdout,
    );
    if (changed.length > this.maxChangedFiles) throw new Error("vcs_changed_file_limit");
    const protectedMatchers = prepared.protectedPaths.map((path) => ({ path, matcher: globRegex(path) }));
    const protectedChange = changed.find((path) => protectedMatchers.some(({ matcher }) => matcher.test(path)));
    if (protectedChange) throw new Error(`vcs_protected_path:${protectedChange}`);

    let diff: string;
    try {
      diff = (
        await this.gitFor(
          prepared,
          ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", prepared.baseCommit, "--"],
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
    const currentHead = await this.revParse(prepared, "HEAD");
    if (changed.length === 0 && currentHead === prepared.baseCommit) {
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
    if (currentHead === prepared.baseCommit) {
      await this.gitFor(prepared, ["commit", "--no-verify", "--no-gpg-sign", "-m", `Wardby run ${prepared.runId}`]);
      commitSha = await this.revParse(prepared, "HEAD");
    } else {
      const parent = await this.revParse(prepared, "HEAD^");
      if (parent !== prepared.baseCommit) throw new Error("vcs_commit_history_invalid");
      const afterCommitChanges = nullSeparated(
        (await this.gitFor(prepared, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"])).stdout,
      );
      if (afterCommitChanges.length > 0) throw new Error("vcs_finalized_workspace_changed");
      commitSha = currentHead;
    }

    await this.pushOnce(prepared, commitSha);
    // Revision-in-place: identify the PR by the run that originally opened
    // it (createOrFindDraftPullRequest's marker-based lookup keys on that
    // run's id), not this run's own -- this finds the existing open PR and
    // returns it rather than creating a new one, since headRef/baseRef
    // already match it exactly. No other change needed here: pushing a new
    // commit onto that branch already updates the PR natively.
    const pullRequest = await this.options.github.createOrFindDraftPullRequest({
      runId: prepared.continuation?.rootRunId ?? prepared.runId,
      repository: prepared.repository,
      baseRef: prepared.baseRef,
      headRef: prepared.headRef,
      summary: details?.summary,
      tests: details?.tests,
      tag: details?.tag,
    });
    return {
      outcome: prepared.continuation ? "pull_request_updated" : "pull_request_opened",
      repository: prepared.repository,
      baseRef: prepared.baseRef,
      baseCommit: prepared.baseCommit,
      headRef: prepared.headRef,
      commitSha,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
    };
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
   * Best-effort "wardby is working on this PR" signal (see VcsProvider) --
   * whole body wrapped so this can NEVER throw or otherwise affect the
   * real coding run, mirroring docker.ts's readWorkerFailureDiagnostic
   * ("diagnostics are optional and must never affect terminal cleanup").
   * No-op for a fresh (non-continuation) workspace: there's no PR to
   * attach anything to until its one commit lands.
   */
  async notifyContinuationStarted(workspace: PreparedWorkspace, details?: { agentName?: string }): Promise<void> {
    if (!workspace.continuation) return;
    try {
      const identity = {
        runId: workspace.runId,
        rootRunId: workspace.continuation.rootRunId,
        repository: workspace.repository,
        baseRef: workspace.baseRef,
        headRef: workspace.headRef,
      };
      await Promise.allSettled([
        this.options.github.upsertContinuationStatusComment({
          ...identity,
          body: `🔄 ${runLabel(details?.agentName, workspace.runId)} is working on this PR...`,
        }),
        this.options.github.createContinuationCheckRun({
          repository: workspace.repository,
          headSha: workspace.baseCommit,
          runId: workspace.runId,
        }),
      ]);
    } catch {
      // Best-effort observability only -- must never affect the real run.
    }
  }

  /**
   * Companion to notifyContinuationStarted -- finds and updates whatever
   * that call created, never creates fresh state itself (see
   * upsertContinuationStatusComment vs updateContinuationStatusComment,
   * and createContinuationCheckRun vs completeContinuationCheckRun in
   * github.ts). Safe to call more than once for the same run. Same
   * never-throw contract as notifyContinuationStarted.
   */
  async notifyContinuationFinished(
    workspace: PreparedWorkspace,
    outcome: "succeeded" | "failed",
    details?: { summary?: string; agentName?: string },
  ): Promise<void> {
    if (!workspace.continuation) return;
    try {
      const identity = {
        runId: workspace.runId,
        rootRunId: workspace.continuation.rootRunId,
        repository: workspace.repository,
        baseRef: workspace.baseRef,
        headRef: workspace.headRef,
      };
      const label = runLabel(details?.agentName, workspace.runId);
      const summarySuffix = details?.summary ? `\n\n${details.summary}` : "";
      const body =
        outcome === "succeeded" ? `✅ ${label} finished.${summarySuffix}` : `❌ ${label} failed.${summarySuffix}`;
      await Promise.allSettled([
        this.options.github.updateContinuationStatusComment({ ...identity, body }),
        this.options.github.completeContinuationCheckRun({
          repository: workspace.repository,
          headSha: workspace.baseCommit,
          runId: workspace.runId,
          outcome,
        }),
      ]);
    } catch {
      // Best-effort observability only -- must never affect the real run.
    }
  }

  private validateInput(
    input: VcsPrepareInput,
  ): Omit<PreparedWorkspace, "id" | "baseCommit" | "workspacePath" | "gitMetadataPath"> {
    if (!SAFE_RUN_ID.test(input.runId)) throw new Error("vcs_run_id_invalid");
    const repository = normalizeGitHubRepository(input.repository);
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
    return { runId: input.runId, repository, baseRef, headRef, protectedPaths, continuation };
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
    const expectedUrl = this.cloneUrlForRepository(workspace.repository);
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
    await this.options.github.withRepositoryToken(workspace.repository, async (token) => {
      const remote = await this.remoteHead(workspace, token);
      if (remote === commitSha) return;
      // A continuation's remote branch legitimately already sits at
      // baseCommit (that's the tip we cloned and committed on top of) --
      // that's the expected fast-forward pre-push state, not a conflict.
      // Any OTHER non-null value means something else moved the branch
      // since we cloned (a human push, a race), which is a real conflict.
      if (remote && remote !== workspace.baseCommit) throw new Error("vcs_head_ref_conflict");
      try {
        await this.gitFor(workspace, ["push", "origin", `${commitSha}:refs/heads/${workspace.headRef}`], {
          authToken: token,
        });
      } catch (error) {
        if ((await this.remoteHead(workspace, token)) === commitSha) return;
        throw error;
      }
    });
  }

  private async remoteHead(workspace: PreparedWorkspace, token: string): Promise<string | null> {
    const result = await this.gitFor(workspace, ["ls-remote", "--heads", "origin", `refs/heads/${workspace.headRef}`], {
      authToken: token,
    });
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
