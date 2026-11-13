import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTINUATION_CLOSED_ERROR } from "../../coding/continuation-wording.js";
import { logger } from "../../core/logger.js";
import type {
  ContinuationCheckRunCompleteInput,
  ContinuationCheckRunInput,
  ContinuationStatusCommentInput,
  DescriptionUpdateResult,
  GitHubRepositoryAccess,
  PullRequestInput,
  UpdateDescriptionInput,
  PullRequestResult,
} from "./github.js";
import {
  GitCommandError,
  GitVcsProvider,
  countWorkspaceEntries,
  NodeGitCommandRunner,
  protectedPathMatcher,
  redactGitOutput,
  type GitCommandOptions,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git.js";
import { GitHubRemote } from "./github-remote.js";
import type { GitRemote } from "./remote.js";
import { holdsValueFragment } from "../../sandbox/secret-fragments.test-support.js";
import type { VcsPrepareInput } from "./types.js";
import { collectExclusions, gitExcludePathspecs } from "../../coding/collect-exclude.js";

const TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz-1234567890.example";
const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);
const REPOSITORY = "openai/example";
const REMOTE_URL = "https://github.com/openai/example.git";

class FakeGitHub implements GitHubRepositoryAccess {
  tokenCalls = 0;
  pullRequestCalls: PullRequestInput[] = [];
  statusCommentCalls: { method: "upsert" | "update"; input: ContinuationStatusCommentInput }[] = [];
  checkRunCalls: {
    method: "create" | "complete";
    input: ContinuationCheckRunInput | ContinuationCheckRunCompleteInput;
  }[] = [];
  /** Set to make every continuation-notification call reject, to prove the caller swallows it. */
  failContinuationCalls = false;
  /** What findOpenPullRequest answers; set null to simulate a merged/closed PR. */
  openPullRequest: PullRequestResult | null = { number: 42, url: "https://github.com/openai/example/pull/42" };
  openPullRequestCalls: unknown[] = [];
  /** Thrown this many times in a row (then answers `openPullRequest` normally) -- simulates a transient GitHub failure. */
  openPullRequestFailuresRemaining = 0;

  /** What openPullRequestDraft answers; an Error is thrown. */
  openPullRequestDraftAnswer: boolean | null | Error = true;
  async openPullRequestDraft(): Promise<boolean | null> {
    if (this.openPullRequestDraftAnswer instanceof Error) throw this.openPullRequestDraftAnswer;
    return this.openPullRequestDraftAnswer;
  }

  async findOpenPullRequest(input: unknown): Promise<PullRequestResult | null> {
    this.openPullRequestCalls.push(structuredClone(input));
    if (this.openPullRequestFailuresRemaining > 0) {
      this.openPullRequestFailuresRemaining -= 1;
      throw new Error("github_api_error:503");
    }
    return this.openPullRequest;
  }

  async withRepositoryToken<T>(_repository: string, action: (token: string) => Promise<T>): Promise<T> {
    this.tokenCalls += 1;
    return action(TOKEN);
  }

  /** Set to make createOrFindDraftPullRequest report the created body's hash. */
  createdDescriptionSha256: string | undefined;
  descriptionCalls: UpdateDescriptionInput[] = [];
  /** Call order across the fake's PR methods. */
  order: string[] = [];
  descriptionResult: DescriptionUpdateResult = { kind: "replaced", sha256: "n".repeat(64), agentTextRunId: "run-2" };
  descriptionThrows = false;

  async updatePullRequestDescription(input: UpdateDescriptionInput): Promise<DescriptionUpdateResult> {
    this.order.push("update");
    this.descriptionCalls.push(structuredClone(input));
    if (this.descriptionThrows) throw new Error("boom");
    return this.descriptionResult;
  }

  proposeCalls: UpdateDescriptionInput[] = [];
  /** Set by the test: called when the comment is proposed, to observe what happened before it. */
  onPropose?: () => void;
  proposeThrows = false;

  async proposeDescriptionComment(input: UpdateDescriptionInput): Promise<boolean> {
    this.order.push("propose");
    this.proposeCalls.push(structuredClone(input));
    this.onPropose?.();
    if (this.proposeThrows) throw new Error("boom");
    return true;
  }

  async createOrFindDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    this.order.push("create");
    this.pullRequestCalls.push(structuredClone(input));
    return {
      number: 42,
      url: "https://github.com/openai/example/pull/42",
      ...(this.createdDescriptionSha256 ? { descriptionSha256: this.createdDescriptionSha256 } : {}),
    };
  }

  async upsertContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void> {
    if (this.failContinuationCalls) throw new Error("github_api_error:500");
    this.statusCommentCalls.push({ method: "upsert", input: structuredClone(input) });
  }

  async updateContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void> {
    if (this.failContinuationCalls) throw new Error("github_api_error:500");
    this.statusCommentCalls.push({ method: "update", input: structuredClone(input) });
  }

  async createContinuationCheckRun(input: ContinuationCheckRunInput): Promise<void> {
    if (this.failContinuationCalls) throw new Error("github_api_error:500");
    this.checkRunCalls.push({ method: "create", input: structuredClone(input) });
  }

  async completeContinuationCheckRun(input: ContinuationCheckRunCompleteInput): Promise<void> {
    if (this.failContinuationCalls) throw new Error("github_api_error:500");
    this.checkRunCalls.push({ method: "complete", input: structuredClone(input) });
  }
}

interface RecordedCall {
  args: string[];
  options?: GitCommandOptions;
}

class ScriptedGitRunner implements GitCommandRunner {
  calls: RecordedCall[] = [];
  changedPaths: string[] = ["src/index.ts"];
  afterCommitChangedPaths: string[] = [];
  diff = "diff --git a/src/index.ts b/src/index.ts\n";
  headSha = BASE_SHA;
  remoteSha: string | null = null;
  remoteUrl = REMOTE_URL;
  pushFails = false;
  /** When set alongside `pushFails`, the remote branch moves here as the push fails (a racing writer). */
  remoteShaOnFailedPush: string | null = null;
  headRef = "wardby/run-run-1";
  /** What `rev-parse` answers for a remote link's ref (refs/remotes/<name>/<label>). */
  remoteRefs: Record<string, string> = {};
  /** Thrown by a fetch from an https URL (a remote link's fetch). */
  fetchError: Error | null = null;

  async run(args: readonly string[], options?: GitCommandOptions): Promise<GitCommandResult> {
    const copied = [...args];
    this.calls.push({ args: copied, options: options ? { ...options } : undefined });
    const command = copied.find((value) =>
      [
        "clone",
        "config",
        "branch",
        "symbolic-ref",
        "read-tree",
        "remote",
        "add",
        "diff",
        "commit",
        "rev-parse",
        "ls-remote",
        "push",
        "fetch",
      ].includes(value),
    );
    if (command === "clone") {
      const metadataPath = copied[copied.indexOf("--separate-git-dir") + 1];
      const workspacePath = copied.at(-1)!;
      await mkdir(metadataPath, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(resolve(workspacePath, ".git"), `gitdir: ${metadataPath}\n`);
      await writeFile(
        resolve(metadataPath, "config"),
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "\tbare = false",
          `\tworktree = ${workspacePath}`,
          '[remote "origin"]',
          `\turl = ${this.remoteUrl}`,
          "\tfetch = +refs/heads/main:refs/remotes/origin/main",
        ].join("\n"),
      );
    }
    if (command === "remote") {
      if (copied.includes("get-url")) return { stdout: `${this.remoteUrl}\n`, stderr: "" };
      return { stdout: "origin\n", stderr: "" };
    }
    if (command === "fetch" && this.fetchError && copied.some((arg) => arg.startsWith("https://"))) {
      throw this.fetchError;
    }
    if (command === "rev-parse") {
      const revision = copied.at(-1)!;
      if (revision.startsWith("refs/remotes/origin/")) return { stdout: `${BASE_SHA}\n`, stderr: "" };
      const remoteTip = this.remoteRefs[revision.replace(/\^\{commit\}$/, "")];
      if (remoteTip) return { stdout: `${remoteTip}\n`, stderr: "" };
      if (revision === "HEAD^") return { stdout: `${BASE_SHA}\n`, stderr: "" };
      return { stdout: `${this.headSha}\n`, stderr: "" };
    }
    if (command === "symbolic-ref" && copied.includes("--short")) {
      return { stdout: `${this.headRef}\n`, stderr: "" };
    }
    if (command === "diff") {
      if (copied.includes("--name-only")) {
        const paths = copied.includes("HEAD") ? this.afterCommitChangedPaths : this.changedPaths;
        return { stdout: paths.length ? `${paths.join("\0")}\0` : "", stderr: "" };
      }
      return { stdout: this.diff, stderr: "" };
    }
    if (command === "commit") this.headSha = COMMIT_SHA;
    if (command === "ls-remote") {
      return {
        stdout: this.remoteSha ? `${this.remoteSha}\trefs/heads/${this.headRef}\n` : "",
        stderr: "",
      };
    }
    if (command === "push") {
      if (this.pushFails) {
        if (this.remoteShaOnFailedPush) this.remoteSha = this.remoteShaOnFailedPush;
        throw new GitCommandError(1, "push rejected");
      }
      this.remoteSha = this.headSha;
    }
    return { stdout: "", stderr: "" };
  }
}

const roots: string[] = [];

async function harness(overrides: Partial<ConstructorParameters<typeof GitVcsProvider>[0]> = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "wardby-vcs-test-"));
  roots.push(rootDir);
  const github = new FakeGitHub();
  const git = new ScriptedGitRunner();
  const sleeps: number[] = [];
  const provider = new GitVcsProvider({
    rootDir,
    remote: new GitHubRemote({
      github,
      // No-op by default: a test asserting the real retry delay overrides this.
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
    git,
    ...overrides,
  });
  const input: VcsPrepareInput = {
    runId: "run-1",
    repository: REPOSITORY,
    baseRef: "main",
    headRef: "wardby/run-run-1",
    protectedPaths: [".github/workflows/**", "CODEOWNERS"],
  };
  return { rootDir, github, git, provider, input, sleeps };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitVcsProvider", () => {
  it("recovers and revalidates a deterministic workspace without minting another token", async () => {
    const { provider, github, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await expect(provider.recoverWorkspace(input)).resolves.toEqual(prepared);
    expect(github.tokenCalls).toBe(1);
  });

  it("prepares separate Git metadata at an immutable base commit without leaking the token", async () => {
    const { provider, github, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);

    expect(prepared).toMatchObject({
      id: "vcs-run-1",
      repository: REPOSITORY,
      baseCommit: BASE_SHA,
      headRef: "wardby/run-run-1",
    });
    expect(prepared.gitMetadataPath).not.toContain(`${prepared.workspacePath}/`);
    await expect(readFile(resolve(prepared.workspacePath, ".git"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const clone = git.calls.find((call) => call.args.includes("clone"))!;
    expect(clone.args).toEqual(
      expect.arrayContaining(["--no-checkout", "--single-branch", "--no-tags", "--separate-git-dir"]),
    );
    expect(clone.args.join(" ")).not.toContain(TOKEN);
    expect(clone.options?.authToken).toBe(TOKEN);
    expect(github.tokenCalls).toBe(1);
  });

  it("clones shallowly: depth 1, since the worker never sees history and finalization needs only baseCommit", async () => {
    const { provider, git, input } = await harness();
    await provider.prepareWorkspace(input);
    const clone = git.calls.find((call) => call.args.includes("clone"))!;
    const depthAt = clone.args.indexOf("--depth");
    expect(depthAt).toBeGreaterThan(-1);
    expect(clone.args[depthAt + 1]).toBe("1");
  });

  it("tells the PR which lock files the run changed", async () => {
    const { provider, github, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    git.changedPaths = ["src/app.ts", "package-lock.json", "web/yarn.lock", "notes.lock.md"];
    await provider.finalizeChanges(prepared);
    expect(github.pullRequestCalls[0].changedLockfiles).toEqual(["package-lock.json", "web/yarn.lock"]);
  });

  it("passes the related pull requests through to the PR it opens", async () => {
    const { provider, github, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
    const related = {
      entries: [
        { repository: "acme/bff", number: 3 },
        { repository: "openai/example", self: true },
      ],
    };
    await provider.finalizeChanges(prepared, { related });
    expect(github.pullRequestCalls[0].related).toEqual(related);
  });

  it("passes the same-repository issue number through to the PR it opens", async () => {
    const { provider, github, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
    await provider.finalizeChanges(prepared, { issueNumber: 12 });
    expect(github.pullRequestCalls[0].issueNumber).toBe(12);
  });

  it("commits with controlled settings, pushes once, and creates one typed draft PR result", async () => {
    const { provider, github, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");

    await expect(provider.finalizeChanges(prepared)).resolves.toEqual({
      outcome: "pull_request_opened",
      repository: REPOSITORY,
      baseRef: "main",
      baseCommit: BASE_SHA,
      headRef: "wardby/run-run-1",
      commitSha: COMMIT_SHA,
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/openai/example/pull/42",
    });
    const commit = git.calls.find((call) => call.args.includes("commit"))!;
    expect(commit.args).toEqual(
      expect.arrayContaining([
        "core.hooksPath=/dev/null",
        "commit.gpgSign=false",
        "commit",
        "--no-verify",
        "--no-gpg-sign",
      ]),
    );
    const push = git.calls.find((call) => call.args.includes("push"))!;
    expect(push.args.join(" ")).not.toContain(TOKEN);
    expect(push.args).toContain(`${COMMIT_SHA}:refs/heads/wardby/run-run-1`);
    expect(github.pullRequestCalls).toHaveLength(1);
    // A fresh run only ever opens or finds a draft PR.
    expect(github.pullRequestCalls[0]?.acceptReadyForReview).toBeUndefined();
  });

  it("passes the agent's summary, tests, and tag through to the pull request", async () => {
    const { provider, github, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");

    await provider.finalizeChanges(prepared, {
      summary: "Fixed the failing test.",
      tests: [{ command: "npm test", outcome: "passed" }],
      tag: "JIRA-123",
    });
    expect(github.pullRequestCalls[0]).toMatchObject({
      summary: "Fixed the failing test.",
      tests: [{ command: "npm test", outcome: "passed" }],
      tag: "JIRA-123",
    });
  });

  it.each([".github/workflows/release.yml", "CODEOWNERS"])(
    "rejects protected path changes before commit or push (%s)",
    async (path) => {
      const { provider, git, input } = await harness();
      const prepared = await provider.prepareWorkspace(input);
      git.changedPaths = [path];
      await expect(provider.finalizeChanges(prepared)).rejects.toThrow(`vcs_protected_path:${path}`);
      expect(git.calls.some((call) => call.args.includes("commit"))).toBe(false);
      expect(git.calls.some((call) => call.args.includes("push"))).toBe(false);
    },
  );

  it("rejects symlinks escaping the workspace before staging", async () => {
    const { provider, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await symlink("/etc/passwd", resolve(prepared.workspacePath, "escape"));
    const callsBefore = git.calls.length;
    await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_symlink_escape");
    expect(git.calls.slice(callsBefore).some((call) => call.args.includes("add"))).toBe(false);
  });

  it("rejects nested repositories and special Git control paths", async () => {
    const { provider, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await mkdir(resolve(prepared.workspacePath, "vendor", ".git"), { recursive: true });
    await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_nested_repository");
  });

  it("stages with exclude pathspecs so excluded paths are neither added nor deleted", async () => {
    const { provider, git, input } = await harness();
    const prepared = await provider.prepareWorkspace({ ...input, collectExclude: ["web/dist"] });
    await provider.finalizeChanges(prepared);
    const add = git.calls.find((call) => call.args.includes("add"));
    expect(add?.args.slice(add.args.indexOf("--"))).toEqual([
      "--",
      ":/",
      ...gitExcludePathspecs(collectExclusions(["web/dist"])),
    ]);
  });

  it("carries collectExclude through recovery and rejects a tampered handle", async () => {
    const { provider, input } = await harness();
    const prepared = await provider.prepareWorkspace({ ...input, collectExclude: ["web/dist"] });
    await expect(provider.recoverWorkspace({ ...input, collectExclude: ["web/dist"] })).resolves.toEqual(prepared);
    await expect(provider.finalizeChanges({ ...prepared, collectExclude: ["../escape"] })).rejects.toThrow();
  });

  it("rejects unexpected fetch or push remotes", async () => {
    const { provider, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    git.remoteUrl = "https://github.com/attacker/repository.git";
    await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_remote_invalid");
  });

  it("rejects credential helpers and token-shaped values persisted in local Git config", async () => {
    const { provider, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await writeFile(resolve(prepared.gitMetadataPath, "config"), `[credential]\n\thelper = !echo ${TOKEN}\n`);
    await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_git_config_unsafe");
  });

  it("enforces changed-file and diff-byte ceilings", async () => {
    const first = await harness({ maxChangedFiles: 1 });
    const firstPrepared = await first.provider.prepareWorkspace(first.input);
    first.git.changedPaths = ["one.ts", "two.ts"];
    await expect(first.provider.finalizeChanges(firstPrepared)).rejects.toThrow("vcs_changed_file_limit");

    const second = await harness({ maxDiffBytes: 8 });
    const secondPrepared = await second.provider.prepareWorkspace(second.input);
    second.git.diff = "123456789";
    await expect(second.provider.finalizeChanges(secondPrepared)).rejects.toThrow("vcs_diff_size_limit");
  });

  it("returns no_changes without a commit, push, or PR", async () => {
    const { provider, github, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    git.changedPaths = [];
    git.diff = "";
    await expect(provider.finalizeChanges(prepared)).resolves.toMatchObject({ outcome: "no_changes" });
    expect(git.calls.some((call) => call.args.includes("commit") || call.args.includes("push"))).toBe(false);
    expect(github.pullRequestCalls).toHaveLength(0);
  });

  it("reuses the same commit, remote branch, and PR on finalize retry", async () => {
    const { provider, github, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    const first = await provider.finalizeChanges(prepared);
    const second = await provider.finalizeChanges(prepared);
    expect(second).toEqual(first);
    expect(git.calls.filter((call) => call.args.includes("commit"))).toHaveLength(1);
    expect(git.calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
    expect(github.pullRequestCalls).toHaveLength(2);
  });

  it("refuses to overwrite a deterministic branch that points to another commit", async () => {
    const { provider, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    git.remoteSha = OTHER_SHA;
    await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_head_ref_conflict");
    expect(git.calls.some((call) => call.args.includes("push"))).toBe(false);
  });

  describe("revision-in-place (continuation)", () => {
    function continuationInput(overrides: Partial<VcsPrepareInput> = {}): VcsPrepareInput {
      return {
        runId: "run-2",
        repository: REPOSITORY,
        baseRef: "main",
        headRef: "wardby/run-run-1",
        protectedPaths: [".github/workflows/**", "CODEOWNERS"],
        continuation: { rootRunId: "run-1" },
        ...overrides,
      };
    }

    it("clones the existing branch (not baseRef), anchors baseCommit on its tip, and updates rather than opens a PR", async () => {
      const { provider, github, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());

      expect(prepared).toMatchObject({
        id: "vcs-run-2",
        headRef: "wardby/run-run-1",
        baseCommit: BASE_SHA,
        continuation: { rootRunId: "run-1" },
      });
      const clone = git.calls.find((call) => call.args.includes("clone"))!;
      const branchFlagIndex = clone.args.indexOf("--branch");
      expect(clone.args[branchFlagIndex + 1]).toBe("wardby/run-run-1");

      // Fidelity: a continuation's remote branch is NOT empty -- it already
      // sits at baseCommit (the tip we just cloned), unlike a fresh run's
      // brand-new headRef. pushOnce must treat that as the expected
      // fast-forward pre-push state, not a conflict.
      git.remoteSha = BASE_SHA;
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      await expect(provider.finalizeChanges(prepared)).resolves.toEqual({
        outcome: "pull_request_updated",
        repository: REPOSITORY,
        baseRef: "main",
        baseCommit: BASE_SHA,
        headRef: "wardby/run-run-1",
        commitSha: COMMIT_SHA,
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/openai/example/pull/42",
      });
      // PR identity is keyed to the ROOT run's id, not this (continuation) run's own.
      // A person may have marked that PR ready for review since; the push
      // above already updated it, so a continuation accepts it as found.
      expect(github.pullRequestCalls[0]).toMatchObject({
        runId: "run-1",
        headRef: "wardby/run-run-1",
        acceptReadyForReview: true,
      });
    });

    const BASELINE = { recordedSha256: "r".repeat(64), previousAgentText: "old", agentTextRunId: "run-1" };

    it("finalizeChanges returns the remote's description outcome on pull_request_updated", async () => {
      const { provider, github, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      git.remoteSha = BASE_SHA;
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      const result = await provider.finalizeChanges(prepared, { summary: "new", description: { baseline: BASELINE } });
      expect(result).toMatchObject({
        outcome: "pull_request_updated",
        description: { kind: "replaced", sha256: "n".repeat(64), agentTextRunId: "run-2" },
      });
      expect(github.descriptionCalls).toHaveLength(1);
    });

    it("publish on a continuation calls updatePullRequestDescription after the push with the root marker id and this run's latestRunId", async () => {
      const { provider, github, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      git.remoteSha = BASE_SHA;
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      await provider.finalizeChanges(prepared, { summary: "new", description: { baseline: BASELINE } });
      expect(github.order).toEqual(["propose", "create", "update"]);
      expect(github.descriptionCalls[0]).toMatchObject({
        rootRunId: "run-1",
        runId: "run-2",
        repository: REPOSITORY,
        headRef: "wardby/run-run-1",
        summary: "new",
        baseline: BASELINE,
      });
    });

    it("proposes the description comment for the new head before the push, then updates after it", async () => {
      const { provider, github, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      git.remoteSha = BASE_SHA;
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      let pushedBeforePropose: boolean | undefined;
      github.onPropose = () => {
        pushedBeforePropose = git.calls.some((call) => call.args.includes("push"));
      };
      const result = await provider.finalizeChanges(prepared, { summary: "new", description: { baseline: BASELINE } });
      expect(pushedBeforePropose).toBe(false);
      expect(github.order).toEqual(["propose", "create", "update"]);
      expect(result.outcome === "pull_request_updated" && result.commitSha).toBeTruthy();
      const commitSha = result.outcome === "pull_request_updated" ? result.commitSha : "";
      expect(github.proposeCalls[0]).toMatchObject({
        rootRunId: "run-1",
        runId: "run-2",
        headSha: commitSha,
        summary: "new",
      });
      expect(github.descriptionCalls[0]).toMatchObject({ headSha: commitSha });
    });

    it("a failed pre-push proposal never stops the push", async () => {
      const { provider, github, git } = await harness();
      github.proposeThrows = true;
      const prepared = await provider.prepareWorkspace(continuationInput());
      git.remoteSha = BASE_SHA;
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      const result = await provider.finalizeChanges(prepared, { summary: "new", description: { baseline: BASELINE } });
      expect(result.outcome).toBe("pull_request_updated");
      expect(git.calls.some((call) => call.args.includes("push"))).toBe(true);
    });

    it("passes the same-repository issue number to the description update", async () => {
      const { provider, github } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      await provider.refreshPullRequestDescription?.(prepared, {
        issueNumber: 12,
        description: { baseline: BASELINE },
      });
      expect(github.descriptionCalls[0]).toMatchObject({ issueNumber: 12 });
    });

    it("a no-change refresh stamps the workspace's head", async () => {
      const { provider, github } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      await provider.refreshPullRequestDescription?.(prepared, { description: { baseline: BASELINE } });
      expect(github.descriptionCalls[0]).toMatchObject({ headSha: prepared.baseCommit });
      expect(github.proposeCalls).toHaveLength(0);
    });

    it("a continuation without details.description never touches the description", async () => {
      const { provider, github, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      git.remoteSha = BASE_SHA;
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      const result = await provider.finalizeChanges(prepared);
      expect(github.descriptionCalls).toHaveLength(0);
      expect(result).not.toHaveProperty("description");
    });

    it("a description failure never fails publish", async () => {
      const { provider, github, git } = await harness();
      github.descriptionThrows = true;
      const prepared = await provider.prepareWorkspace(continuationInput());
      git.remoteSha = BASE_SHA;
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      const result = await provider.finalizeChanges(prepared, { description: { baseline: BASELINE } });
      expect(result).toMatchObject({
        outcome: "pull_request_updated",
        description: { kind: "skipped", reason: "error" },
      });
    });

    it("refreshPullRequestDescription delegates to the remote and never throws", async () => {
      const { provider, github } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      await expect(
        provider.refreshPullRequestDescription?.(prepared, { description: { baseline: BASELINE } }),
      ).resolves.toMatchObject({ kind: "replaced" });
      expect(github.order).toEqual(["update"]);
      github.descriptionThrows = true;
      await expect(
        provider.refreshPullRequestDescription?.(prepared, { description: { baseline: BASELINE } }),
      ).resolves.toEqual({ kind: "skipped", reason: "error" });
      await expect(provider.refreshPullRequestDescription?.(prepared, {})).resolves.toBeUndefined();
    });

    it("continuationPullRequestDraft reports the host's draft state, and undefined when it is unknown", async () => {
      const { provider, github } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      github.openPullRequestDraftAnswer = true;
      await expect(provider.continuationPullRequestDraft?.(prepared)).resolves.toBe(true);
      github.openPullRequestDraftAnswer = false;
      await expect(provider.continuationPullRequestDraft?.(prepared)).resolves.toBe(false);
      github.openPullRequestDraftAnswer = null;
      await expect(provider.continuationPullRequestDraft?.(prepared)).resolves.toBeUndefined();
      github.openPullRequestDraftAnswer = new Error("github_api_error:503");
      await expect(provider.continuationPullRequestDraft?.(prepared)).resolves.toBeUndefined();
      const { continuation: _continuation, ...fresh } = prepared;
      await expect(provider.continuationPullRequestDraft?.(fresh)).resolves.toBeUndefined();
    });

    it("refuses to prepare a continuation whose PR is no longer open, before cloning", async () => {
      const { provider, github, git } = await harness();
      github.openPullRequest = null;
      await expect(provider.prepareWorkspace(continuationInput())).rejects.toThrow(CONTINUATION_CLOSED_ERROR);
      expect(github.openPullRequestCalls[0]).toMatchObject({ runId: "run-1", headRef: "wardby/run-run-1" });
      expect(git.calls.some((call) => call.args.includes("clone"))).toBe(false);
    });

    it("refuses to push when the PR was merged or closed while the run worked", async () => {
      const { provider, github, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      git.remoteSha = BASE_SHA;
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      github.openPullRequest = null;
      await expect(provider.finalizeChanges(prepared)).rejects.toThrow(CONTINUATION_CLOSED_ERROR);
      expect(git.calls.some((call) => call.args.includes("push"))).toBe(false);
      expect(github.pullRequestCalls).toHaveLength(0);
    });

    it("a fresh publish reports written with the created hash", async () => {
      const { provider, github, input } = await harness();
      github.createdDescriptionSha256 = "h".repeat(64);
      const prepared = await provider.prepareWorkspace(input);
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      const result = await provider.finalizeChanges(prepared);
      expect(result).toMatchObject({
        outcome: "pull_request_opened",
        description: { kind: "written", sha256: "h".repeat(64) },
      });
      expect(github.descriptionCalls).toHaveLength(0);
      expect(github.proposeCalls).toHaveLength(0);
    });

    it("never asks for a fresh run", async () => {
      const { provider, github, input } = await harness();
      const prepared = await provider.prepareWorkspace(input);
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      await provider.finalizeChanges(prepared);
      expect(github.openPullRequestCalls).toHaveLength(0);
    });

    it("retries once on a transient open-PR check failure, after a short wait, then proceeds as if it were still open", async () => {
      const { provider, github, sleeps } = await harness();
      github.openPullRequestFailuresRemaining = 1;
      await expect(provider.prepareWorkspace(continuationInput())).resolves.toMatchObject({
        headRef: "wardby/run-run-1",
      });
      expect(github.openPullRequestCalls).toHaveLength(2);
      expect(sleeps).toEqual([1_000]);
    });

    it("proceeds, with a warning, when the open-PR check fails twice in a row -- never failing the run on an unconfirmed answer", async () => {
      const { provider, github } = await harness();
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      github.openPullRequestFailuresRemaining = 2;
      await expect(provider.prepareWorkspace(continuationInput())).resolves.toMatchObject({
        headRef: "wardby/run-run-1",
      });
      expect(github.openPullRequestCalls).toHaveLength(2);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("retries once on a transient open-PR check failure at the pre-push check too, then proceeds", async () => {
      const { provider, github, sleeps } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      github.openPullRequestFailuresRemaining = 1;
      await expect(provider.finalizeChanges(prepared)).resolves.toMatchObject({ outcome: "pull_request_updated" });
      // One call during prepare (succeeded first try), two more at the pre-push check (fail then succeed).
      expect(github.openPullRequestCalls).toHaveLength(3);
      expect(sleeps).toEqual([1_000]);
    });

    it("recovers a continuation workspace deterministically without minting another token", async () => {
      const { provider, github } = await harness();
      const input = continuationInput();
      const prepared = await provider.prepareWorkspace(input);
      await expect(provider.recoverWorkspace(input)).resolves.toEqual(prepared);
      expect(github.tokenCalls).toBe(1);
    });

    it("rejects a continuation whose headRef doesn't match the claimed root run", async () => {
      const { provider } = await harness();
      await expect(
        provider.prepareWorkspace(continuationInput({ continuation: { rootRunId: "some-other-run" } })),
      ).rejects.toThrow("vcs_head_ref_invalid");
    });

    it("rejects a malformed continuation root run id", async () => {
      const { provider } = await harness();
      await expect(
        provider.prepareWorkspace(continuationInput({ continuation: { rootRunId: "not valid!" } })),
      ).rejects.toThrow("vcs_root_run_id_invalid");
    });

    it("still enforces protected paths across the continuation's own diff", async () => {
      const { provider, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      git.changedPaths = ["CODEOWNERS"];
      await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_protected_path:CODEOWNERS");
    });

    it("propagates the push's own failure when the remote branch still sits at baseCommit (not a conflict)", async () => {
      const { provider, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      git.remoteSha = BASE_SHA;
      git.pushFails = true;
      const failure = provider.finalizeChanges(prepared);
      await expect(failure).rejects.toThrow("push rejected");
      await expect(failure).rejects.not.toThrow("vcs_head_ref_conflict");
    });

    it("reports a conflict when the push fails because the remote branch raced to another commit", async () => {
      const { provider, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      git.remoteSha = BASE_SHA;
      git.pushFails = true;
      git.remoteShaOnFailedPush = OTHER_SHA;
      await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_head_ref_conflict");
    });

    it("still rejects a genuine conflict: the remote branch moved to neither baseCommit nor our new commit", async () => {
      const { provider, git } = await harness();
      const prepared = await provider.prepareWorkspace(continuationInput());
      await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");
      git.remoteSha = OTHER_SHA;
      await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_head_ref_conflict");
    });

    describe("continuation notifications (best-effort GitHub status signal)", () => {
      it("notifyContinuationStarted posts a status comment and creates a check run, keyed to this round's own runId", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationStarted(prepared);

        expect(github.statusCommentCalls).toEqual([
          {
            method: "upsert",
            input: {
              runId: "run-2",
              rootRunId: "run-1",
              repository: REPOSITORY,
              baseRef: "main",
              headRef: "wardby/run-run-1",
              body: "🔄 wardby run run-2 is working on this PR...",
            },
          },
        ]);
        expect(github.checkRunCalls).toEqual([
          { method: "create", input: { repository: REPOSITORY, headSha: BASE_SHA, runId: "run-2" } },
        ]);
      });

      it("notifyContinuationFinished updates the status comment and completes the check run with the given outcome", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "succeeded");

        expect(github.statusCommentCalls).toEqual([
          {
            method: "update",
            input: {
              runId: "run-2",
              rootRunId: "run-1",
              repository: REPOSITORY,
              baseRef: "main",
              headRef: "wardby/run-run-1",
              body: "✅ wardby run run-2 finished.",
            },
          },
        ]);
        expect(github.checkRunCalls).toEqual([
          {
            method: "complete",
            input: { repository: REPOSITORY, headSha: BASE_SHA, runId: "run-2", outcome: "succeeded" },
          },
        ]);
      });

      it("prefixes the human-readable agent name ahead of the opaque run id when given one", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationStarted(prepared, { agentName: "knock-knock-implement" });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "🔄 knock-knock-implement (wardby run run-2) is working on this PR...",
        );
      });

      it("includes the agent name in the done comment too, particularly useful for the cross-agent case", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "succeeded", { agentName: "knock-knock-implement" });

        expect(github.statusCommentCalls[0].input.body).toBe("✅ knock-knock-implement (wardby run run-2) finished.");
      });

      it("includes the agent's own summary in the done comment when given one", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "succeeded", {
          summary: "Added timestamped logging for every served joke.",
        });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "✅ wardby run run-2 finished.\n\nAdded timestamped logging for every served joke.",
        );
      });

      it("puts the overrun sentence in the done comment", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "succeeded", {
          overrunSentence: "Spent $1.04, $0.04 (4%) over its $1.00 budget, within its allowed overrun.",
          summary: "Done.",
        });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "✅ wardby run run-2 finished. Spent $1.04, $0.04 (4%) over its $1.00 budget, within its allowed overrun.\n\nDone.",
        );
      });

      it("omits the summary suffix entirely when none is given", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "failed", {});

        expect(github.statusCommentCalls[0].input.body).toBe("❌ wardby run run-2 failed.");
      });

      it("uses a failed-shaped body/outcome when the run failed", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "failed");

        expect(github.statusCommentCalls[0].input.body).toBe("❌ wardby run run-2 failed.");
        expect(github.checkRunCalls[0].input).toMatchObject({ outcome: "failed" });
      });

      it("says the run ran out of budget, with the budget sentence, and fails the check run", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "budget_exhausted", {
          agentName: "builder",
          budgetSentence: "Out of budget: this run's $3.00 budget was used up.",
        });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "❌ builder (wardby run run-2) ran out of budget. Out of budget: this run's $3.00 budget was used up.",
        );
        expect(github.checkRunCalls[0].input).toMatchObject({ outcome: "failed" });
      });

      it("says a budget-stopped run's changes were pushed and how to continue it", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "budget_exhausted", {
          agentName: "builder",
          budgetSentence: "Out of budget: this run's $3.00 budget was used up.",
          changesPushed: { pullRequestNumber: 42 },
          summary: "Half done.",
        });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "⚠️ builder (wardby run run-2) ran out of budget before finishing. Out of budget: this run's $3.00 budget was used up. " +
            "The changes so far are in #42; mention the agent on it to continue.\n\nHalf done.",
        );
        expect(github.checkRunCalls[0].input).toMatchObject({ outcome: "failed" });
      });

      it("says the run could not run when the model provider refused it, and fails the check run", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "failed", {
          agentName: "builder",
          providerSentence: "The model provider rejected the request.",
        });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "❌ builder (wardby run run-2) could not run: The model provider rejected the request.",
        );
        expect(github.checkRunCalls[0].input).toMatchObject({ outcome: "failed" });
      });

      it("says the run could not start when a service never became ready", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "failed", {
          agentName: "builder",
          serviceSentence: "The `postgres` service didn't become ready, so the run couldn't start.",
        });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "❌ builder (wardby run run-2) could not start: The `postgres` service didn't become ready, so the run couldn't start.",
        );
        expect(github.checkRunCalls[0].input).toMatchObject({ outcome: "failed" });
      });

      it("says the run could not open its changes when they touched a protected path", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "failed", {
          agentName: "builder",
          protectedPathSentence:
            "its changes include `CODEOWNERS`, which this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
        });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "❌ builder (wardby run run-2) could not open its changes: its changes include `CODEOWNERS`, which this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
        );
        expect(github.checkRunCalls[0].input).toMatchObject({ outcome: "failed" });
      });

      it("is a no-op for a fresh (non-continuation) workspace", async () => {
        const { provider, github, input } = await harness();
        const prepared = await provider.prepareWorkspace(input);

        await provider.notifyContinuationStarted(prepared);
        await provider.notifyContinuationFinished(prepared, "succeeded");

        expect(github.statusCommentCalls).toHaveLength(0);
        expect(github.checkRunCalls).toHaveLength(0);
      });

      it("swallows a GitHub API failure without throwing -- must never affect the real coding run", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());
        github.failContinuationCalls = true;

        await expect(provider.notifyContinuationStarted(prepared)).resolves.toBeUndefined();
        await expect(provider.notifyContinuationFinished(prepared, "failed")).resolves.toBeUndefined();
      });
    });
  });

  it("cleans up idempotently but rejects a forged cleanup path", async () => {
    const { rootDir, provider, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await provider.cleanup(prepared);
    await provider.cleanup(prepared);
    await expect(provider.cleanup({ ...prepared, workspacePath: rootDir })).rejects.toThrow(
      "vcs_workspace_handle_invalid",
    );
  });

  it("reads a repository file through its GitHub access, validating the input first", async () => {
    const { provider, github } = await harness();
    const asked: unknown[] = [];
    (github as FakeGitHub & { readFileAtRef?: (input: unknown) => Promise<string | null> }).readFileAtRef = async (
      input,
    ) => {
      asked.push(input);
      return "services: {}\n";
    };
    await expect(
      provider.readRepositoryFile({
        repository: "OpenAI/Example",
        ref: "refs/heads/main",
        path: ".wardby/services.yaml",
        maxBytes: 8192,
      }),
    ).resolves.toBe("services: {}\n");
    expect(asked).toEqual([
      { repository: "openai/example", ref: "main", path: ".wardby/services.yaml", maxBytes: 8192 },
    ]);
    await expect(
      provider.readRepositoryFile({ repository: REPOSITORY, ref: "main", path: "../x", maxBytes: 8192 }),
    ).rejects.toThrow("vcs_changed_path_invalid");
  });

  it("says it cannot read files when its GitHub access has no file read", async () => {
    const { provider } = await harness();
    await expect(
      provider.readRepositoryFile({
        repository: REPOSITORY,
        ref: "main",
        path: ".wardby/services.yaml",
        maxBytes: 8192,
      }),
    ).rejects.toThrow("vcs_read_file_unsupported");
  });

  it("lets an exception carve a path out of a protected pattern, whatever the order", async () => {
    const { provider, git, input } = await harness();
    const prepared = await provider.prepareWorkspace({
      ...input,
      protectedPaths: ["!.wardby/services.yaml", ".wardby/**", "CODEOWNERS"],
    });
    await mkdir(resolve(prepared.workspacePath, ".wardby"), { recursive: true });
    await writeFile(resolve(prepared.workspacePath, ".wardby", "services.yaml"), 'services:\n  redis: "7"\n');
    git.changedPaths = [".wardby/services.yaml"];
    await expect(provider.finalizeChanges(prepared)).resolves.toMatchObject({ outcome: "pull_request_opened" });
  });

  it("still protects everything else the pattern covers", async () => {
    const { provider, git, input } = await harness();
    const prepared = await provider.prepareWorkspace({
      ...input,
      protectedPaths: [".wardby/**", "!.wardby/services.yaml"],
    });
    git.changedPaths = [".wardby/services.yaml", ".wardby/other.yaml"];
    await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_protected_path:.wardby/other.yaml");
  });

  it("refuses a protected-path list made only of exceptions", async () => {
    const { provider, input } = await harness();
    await expect(provider.prepareWorkspace({ ...input, protectedPaths: ["!.wardby/services.yaml"] })).rejects.toThrow(
      "vcs_protected_paths_invalid",
    );
  });

  it("protects .wardby/ for an agent whose stored list predates the baseline, except the declaration", async () => {
    // The harness's list is [".github/workflows/**", "CODEOWNERS"]: no .wardby entry at all.
    const { provider, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    git.changedPaths = [".wardby/notes.md"];
    await expect(provider.finalizeChanges(prepared)).rejects.toThrow("vcs_protected_path:.wardby/notes.md");

    const again = await harness();
    const preparedAgain = await again.provider.prepareWorkspace(again.input);
    await mkdir(resolve(preparedAgain.workspacePath, ".wardby"), { recursive: true });
    await writeFile(resolve(preparedAgain.workspacePath, ".wardby", "services.yaml"), 'services:\n  postgres: "16"\n');
    again.git.changedPaths = [".wardby/services.yaml"];
    await expect(again.provider.finalizeChanges(preparedAgain)).resolves.toMatchObject({
      outcome: "pull_request_opened",
    });
  });
});

describe("GitVcsProvider git history (#536)", () => {
  const UPSTREAM_SHA = "d".repeat(40);
  const upstream = { name: "upstream", repository: "openai/upstream", resolvedSha: UPSTREAM_SHA, label: "main" };

  async function historyHarness() {
    const created = await harness();
    created.git.remoteRefs["refs/remotes/upstream/main"] = UPSTREAM_SHA;
    created.git.remoteRefs["refs/remotes/upstream/pinned"] = UPSTREAM_SHA;
    return created;
  }

  it("clones to the history depth, or with no depth for full history (history off stays depth 1)", async () => {
    const depthOf = (calls: RecordedCall[]) => {
      const clone = calls.find((call) => call.args.includes("clone"))!;
      const at = clone.args.indexOf("--depth");
      return at < 0 ? null : clone.args[at + 1];
    };
    const fifty = await historyHarness();
    await fifty.provider.prepareWorkspace({ ...fifty.input, gitHistory: { depth: 50 } });
    expect(depthOf(fifty.git.calls)).toBe("50");
    const full = await historyHarness();
    await full.provider.prepareWorkspace({ ...full.input, gitHistory: { depth: "full" } });
    expect(depthOf(full.git.calls)).toBeNull();
    const clone = full.git.calls.find((call) => call.args.includes("clone"))!;
    expect(clone.args).toEqual(expect.arrayContaining(["--single-branch", "--no-tags", "--separate-git-dir"]));
    const off = await historyHarness();
    await off.provider.prepareWorkspace(off.input);
    expect(depthOf(off.git.calls)).toBe("1");
  });

  it("fetches each remote's commit into refs/remotes/<name>/<label>, hardened, under the remote's read access", async () => {
    const { provider, git, input } = await historyHarness();
    const prepared = await provider.prepareWorkspace({ ...input, gitHistory: { depth: 50 }, remotes: [upstream] });
    const fetch = git.calls.find(
      (call) => call.args.includes("fetch") && call.args.includes("https://github.com/openai/upstream.git"),
    )!;
    expect(fetch).toBeDefined();
    expect(fetch.args.slice(fetch.args.indexOf("fetch"))).toEqual([
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--depth",
      "50",
      "https://github.com/openai/upstream.git",
      `${UPSTREAM_SHA}:refs/remotes/upstream/main`,
    ]);
    expect(fetch.args).toEqual(expect.arrayContaining(["credential.helper=", "protocol.allow=never"]));
    expect(fetch.args.join(" ")).not.toContain(TOKEN);
    expect(fetch.options?.authToken).toBe(TOKEN);
    expect(prepared).toMatchObject({
      gitHistory: { depth: 50 },
      historyBase: BASE_SHA,
      remoteTips: [UPSTREAM_SHA],
      remotes: [upstream],
    });
    // Full history fetches the remote with no depth either.
    const full = await historyHarness();
    await full.provider.prepareWorkspace({ ...full.input, gitHistory: { depth: "full" }, remotes: [upstream] });
    const fullFetch = full.git.calls.find((call) => call.args.includes("https://github.com/openai/upstream.git"))!;
    expect(fullFetch.args).not.toContain("--depth");
  });

  it("builds the worker .git from the control plane's git dir by path, with its own fixed config", async () => {
    const { provider, git, input } = await historyHarness();
    const prepared = await provider.prepareWorkspace({ ...input, gitHistory: { depth: 50 }, remotes: [upstream] });
    const workerGit = resolve(prepared.workspacePath, ".git");
    const worker = git.calls.filter((call) => call.args[0] === `--git-dir=${workerGit}`);
    const init = worker.find((call) => call.args.includes("init"))!;
    expect(init.args).toContain("--template=");
    const fetch = worker.find((call) => call.args.includes("fetch"))!;
    expect(fetch.args).toEqual(expect.arrayContaining(["protocol.file.allow=always", "--update-shallow"]));
    expect(fetch.args.slice(fetch.args.indexOf(prepared.gitMetadataPath))).toEqual([
      prepared.gitMetadataPath,
      `${BASE_SHA}:refs/heads/wardby/run-run-1`,
      `${UPSTREAM_SHA}:refs/remotes/upstream/main`,
    ]);
    expect(fetch.options?.authToken).toBeUndefined();
    const symbolic = worker.find((call) => call.args.includes("symbolic-ref"))!;
    expect(symbolic.args.slice(-2)).toEqual(["HEAD", "refs/heads/wardby/run-run-1"]);
    const readTree = worker.find((call) => call.args.includes("read-tree"))!;
    expect(readTree.args).toContain(`--work-tree=${prepared.workspacePath}`);
    expect(readTree.args.at(-1)).toBe(BASE_SHA);
    expect(readTree.args).not.toContain("-u");
    expect(await readFile(resolve(workerGit, "config"), "utf8")).toBe(
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tbare = false",
        "\thooksPath = /dev/null",
        "[commit]",
        "\tgpgSign = false",
        "[tag]",
        "\tgpgSign = false",
        "[user]",
        "\tname = Wardby",
        "\temail = wardby@users.noreply.github.com",
        "",
      ].join("\n"),
    );
    // No worker .git without history.
    const off = await historyHarness();
    const plain = await off.provider.prepareWorkspace(off.input);
    expect(existsSync(resolve(plain.workspacePath, ".git"))).toBe(false);
  });

  it("files a remote whose label is not a valid ref component under pinned, and refuses an invalid name", async () => {
    const { provider, git, input } = await historyHarness();
    const prepared = await provider.prepareWorkspace({
      ...input,
      gitHistory: { depth: 5 },
      remotes: [{ ...upstream, label: "bad..label" }],
    });
    expect(prepared.remotes).toEqual([{ ...upstream, label: "pinned" }]);
    expect(git.calls.some((call) => call.args.includes(`${UPSTREAM_SHA}:refs/remotes/upstream/pinned`))).toBe(true);
    for (const name of ["origin", "Up", "a..b", "x.lock", "a/b", ""]) {
      const other = await historyHarness();
      await expect(
        other.provider.prepareWorkspace({ ...other.input, gitHistory: { depth: 5 }, remotes: [{ ...upstream, name }] }),
      ).rejects.toThrow("repository_remote_invalid");
    }
    const twice = await historyHarness();
    await expect(
      twice.provider.prepareWorkspace({ ...twice.input, gitHistory: { depth: 5 }, remotes: [upstream, upstream] }),
    ).rejects.toThrow("repository_remote_invalid");
    const noHistory = await historyHarness();
    await expect(noHistory.provider.prepareWorkspace({ ...noHistory.input, remotes: [upstream] })).rejects.toThrow(
      "repository_remote_needs_history",
    );
    const slot = await historyHarness();
    await mkdir(resolve(slot.rootDir, "run-1"), { recursive: true });
    await expect(
      slot.provider.prepareWorkspace({
        ...slot.input,
        slot: { name: "tools" },
        gitHistory: { depth: 5 },
        remotes: [upstream],
      }),
    ).rejects.toThrow("repository_remote_invalid");
    for (const depth of [0, 100_001, 1.5]) {
      const bad = await historyHarness();
      await expect(bad.provider.prepareWorkspace({ ...bad.input, gitHistory: { depth } })).rejects.toThrow(
        "vcs_git_history_invalid",
      );
    }
  });

  it("keeps the token out of vcs_remote_fetch_failed", async () => {
    const { provider, git, input, rootDir } = await historyHarness();
    git.fetchError = new GitCommandError(128, `fatal: https://x-access-token:${TOKEN}@github.com/openai/upstream.git`);
    const error = await provider.prepareWorkspace({ ...input, gitHistory: { depth: 5 }, remotes: [upstream] }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(String(error)).toContain("vcs_remote_fetch_failed:upstream");
    for (let link = error as Error | undefined; link !== undefined; link = link.cause as Error | undefined) {
      expect(link.message).not.toContain(TOKEN);
      expect(link.stack ?? "").not.toContain(TOKEN);
      expect(JSON.stringify(link)).not.toContain(TOKEN);
    }
    expect(String((error as Error).cause)).toContain("[REDACTED]");
    expect(existsSync(resolve(rootDir, "run-1"))).toBe(false);
  });

  it("recovers the history fields, and gitHistory is part of the handle", async () => {
    const { provider, input } = await historyHarness();
    const historyInput = { ...input, gitHistory: { depth: 50 }, remotes: [upstream] };
    const prepared = await provider.prepareWorkspace(historyInput);
    await expect(provider.recoverWorkspace(historyInput)).resolves.toEqual(prepared);
    // A handle whose history fields disagree with themselves is refused.
    await expect(provider.finalizeChanges({ ...prepared, gitHistory: undefined })).rejects.toThrow(
      "repository_remote_needs_history",
    );
    await expect(
      provider.finalizeChanges({ ...prepared, gitHistory: undefined, remotes: undefined, remoteTips: undefined }),
    ).rejects.toThrow("vcs_workspace_handle_invalid");
    for (const changed of [
      { historyBase: undefined },
      { remoteTips: [] },
      { remotes: [{ ...upstream, label: "a..b" }] },
    ]) {
      await expect(provider.finalizeChanges({ ...prepared, ...changed })).rejects.toThrow(
        "vcs_workspace_handle_invalid",
      );
    }
    // Without history, a handle carrying history fields is refused too.
    const plain = await historyHarness();
    const off = await plain.provider.prepareWorkspace(plain.input);
    await expect(plain.provider.finalizeChanges({ ...off, historyBase: BASE_SHA })).rejects.toThrow(
      "vcs_workspace_handle_invalid",
    );
  });

  it("allows only the workspace root's .git, only with history on, and checks its config", async () => {
    const { provider, input } = await historyHarness();
    const historyInput = { ...input, gitHistory: { depth: 50 } };
    const prepared = await provider.prepareWorkspace(historyInput);
    expect(existsSync(resolve(prepared.workspacePath, ".git", "config"))).toBe(true);
    // History off: the same root .git is a nested repository.
    await expect(provider.recoverWorkspace(input)).rejects.toThrow("vcs_nested_repository");
    // Anywhere else, .git is still refused.
    await mkdir(resolve(prepared.workspacePath, "vendor", ".git"), { recursive: true });
    await expect(provider.recoverWorkspace(historyInput)).rejects.toThrow("vcs_nested_repository");
    await rm(resolve(prepared.workspacePath, "vendor"), { recursive: true });
    // The root .git's config must be safe (the worker can write it).
    await writeFile(resolve(prepared.workspacePath, ".git", "config"), "[credential]\n\thelper = store\n");
    await expect(provider.recoverWorkspace(historyInput)).rejects.toThrow("vcs_git_config_unsafe");
    // Never followed as a symlink.
    await rm(resolve(prepared.workspacePath, ".git", "config"));
    await symlink("/etc/passwd", resolve(prepared.workspacePath, ".git", "config"));
    await expect(provider.recoverWorkspace(historyInput)).rejects.toThrow("vcs_git_config_unsafe");
    // A .git that is a file (a gitdir pointer) or a symlink is refused.
    await rm(resolve(prepared.workspacePath, ".git"), { recursive: true });
    await writeFile(resolve(prepared.workspacePath, ".git"), "gitdir: /elsewhere\n");
    await expect(provider.recoverWorkspace(historyInput)).rejects.toThrow("vcs_nested_repository");
    await rm(resolve(prepared.workspacePath, ".git"));
    await symlink("/tmp", resolve(prepared.workspacePath, ".git"));
    await expect(provider.recoverWorkspace(historyInput)).rejects.toThrow("vcs_nested_repository");
  });
});

describe("protectedPathMatcher", () => {
  it("protects matches of any pattern unless an exception matches", () => {
    const isProtected = protectedPathMatcher([".github/workflows/**", ".wardby/**", "!.wardby/services.yaml"]);
    expect(isProtected(".github/workflows/ci.yml")).toBe(true);
    expect(isProtected(".wardby/services.yaml")).toBe(false);
    expect(isProtected(".wardby/nested/services.yaml")).toBe(true);
    expect(isProtected("src/index.ts")).toBe(false);
  });

  it("reads a leading ! as an exception, not a literal file name", () => {
    expect(protectedPathMatcher(["**", "!README.md"])("README.md")).toBe(false);
    expect(protectedPathMatcher(["**", "!README.md"])("!README.md")).toBe(true);
  });

  it("always adds the .wardby/ baseline and its services.yaml exception, whatever the agent's list says", () => {
    const legacy = protectedPathMatcher(["CODEOWNERS"]);
    expect(legacy(".wardby/notes.md")).toBe(true);
    expect(legacy(".wardby/nested/x.yaml")).toBe(true);
    expect(legacy(".wardby/services.yaml")).toBe(false);
    // Even an agent that names the declaration itself cannot stop a builder proposing it.
    expect(protectedPathMatcher(["CODEOWNERS", ".wardby/services.yaml"])(".wardby/services.yaml")).toBe(false);
    expect(protectedPathMatcher(["CODEOWNERS"])("src/index.ts")).toBe(false);
  });
});

describe("protectedPathMatcher baseline precedence", () => {
  it("keeps .wardby/ protected for every list, whatever the agent's exceptions", () => {
    for (const patterns of [
      ["CODEOWNERS"],
      ["CODEOWNERS", "!.wardby/notes.md"],
      [".wardby/**", "!.wardby/notes.md"],
      ["**", "!README.md"],
    ]) {
      expect(protectedPathMatcher(patterns)(".wardby/notes.md")).toBe(true);
    }
  });

  it("leaves .wardby/services.yaml unprotected even when an agent pattern covers it", () => {
    expect(protectedPathMatcher([".wardby/**"])(".wardby/services.yaml")).toBe(false);
    expect(protectedPathMatcher(["**"])(".wardby/services.yaml")).toBe(false);
    expect(protectedPathMatcher([".wardby/services.yaml"])(".wardby/services.yaml")).toBe(false);
  });

  it("applies a literal agent exception only to that exact path", () => {
    const isProtected = protectedPathMatcher(["docs/**", "!docs/CODEOWNERS"]);
    expect(isProtected("docs/CODEOWNERS")).toBe(false);
    expect(isProtected("docs/other.md")).toBe(true);
    expect(isProtected("docs/CODEOWNERS/x")).toBe(true);
  });

  it("behaves as before for lists without exceptions", () => {
    const isProtected = protectedPathMatcher([".github/workflows/**", "CODEOWNERS", "src/*.ts"]);
    expect(isProtected(".github/workflows/ci.yml")).toBe(true);
    expect(isProtected("CODEOWNERS")).toBe(true);
    expect(isProtected("src/index.ts")).toBe(true);
    expect(isProtected("src/nested/index.ts")).toBe(false);
    expect(isProtected("README.md")).toBe(false);
  });

  it.each([["!**"], ["!.wardby/*"], ["!.wardby/**"], ["!*"], ["!.github/**"], ["!docs/CODEOWNER?"]])(
    "refuses the wildcard exception %s when preparing a workspace",
    async (exception) => {
      const { provider, input } = await harness();
      await expect(
        provider.prepareWorkspace({ ...input, protectedPaths: [".github/workflows/**", "CODEOWNERS", exception] }),
      ).rejects.toThrow("vcs_protected_path_invalid");
    },
  );
});

describe("Git process boundary", () => {
  it("redacts raw, encoded, and token-shaped secrets", () => {
    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    const output = redactGitOutput(`raw=${TOKEN} encoded=${encoded}`, [TOKEN, encoded]);
    expect(output).toBe("raw=[REDACTED] encoded=[REDACTED]");
  });

  it("rejects malformed authentication tokens before spawning Git", async () => {
    const runner = new NodeGitCommandRunner({ homeDir: tmpdir() });
    await expect(runner.run(["status"], { authToken: "token\nsecond-line" })).rejects.toThrow("git_auth_token_invalid");
  });

  it("uses argv arrays, strips inherited secrets, and keeps the token outside argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-git-runner-"));
    roots.push(root);
    const executable = resolve(root, "fake-git.mjs");
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        "import { readFileSync } from 'node:fs';",
        "console.log(JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  inherited: process.env.OPENAI_API_KEY ?? null,",
        "  authEnvironmentPresent: Object.keys(process.env).some((key) => key.includes('AUTH_HEADER') || key.includes('TOKEN')) ,",
        "  tokenBytesFromFd: readFileSync(3, 'utf8').trim().length,",
        "}));",
      ].join("\n"),
    );
    await chmod(executable, 0o700);
    process.env.OPENAI_API_KEY = "sk-test-abcdefghijklmnopqrstuvwxyz";
    try {
      const runner = new NodeGitCommandRunner({ gitBinary: executable, homeDir: root });
      const result = await runner.run(["status", "; echo pwn"], { authToken: TOKEN });
      const child = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(child).toEqual({
        argv: ["status", "; echo pwn"],
        inherited: null,
        authEnvironmentPresent: false,
        tokenBytesFromFd: TOKEN.length,
      });
      expect(result.stdout).not.toContain(TOKEN);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("redacts authentication material from child-process failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-git-runner-"));
    roots.push(root);
    const executable = resolve(root, "failing-git.mjs");
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        "import { readFileSync } from 'node:fs';",
        "console.error(readFileSync(3, 'utf8'));",
        "process.exit(2);",
      ].join("\n"),
    );
    await chmod(executable, 0o700);
    const runner = new NodeGitCommandRunner({ gitBinary: executable, homeDir: root });
    const caught: unknown = await runner.run(["push"], { authToken: TOKEN }).catch((error) => error);
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(TOKEN);
  });

  it("authenticates a real Git HTTP challenge through the token pipe", async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      if (!authorization) {
        response.writeHead(401, { "www-authenticate": "Basic realm=wardby-test" });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test_server_address_invalid");
      const root = await mkdtemp(join(tmpdir(), "wardby-git-runner-"));
      roots.push(root);
      const runner = new NodeGitCommandRunner({ homeDir: root });
      const caught: unknown = await runner
        .run(
          [
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.http.allow=always",
            "ls-remote",
            `http://127.0.0.1:${address.port}/owner/repository.git`,
          ],
          { authToken: TOKEN },
        )
        .catch((error) => error);
      expect(caught).toBeInstanceOf(GitCommandError);
      expect(authorization).toBe(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
      expect((caught as Error).message).not.toContain(TOKEN);
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
      );
    }
  });
});

describe("redactGitOutput with a self-overlapping value", () => {
  it("masks every overlapping occurrence, leaving no fragment", () => {
    const value = "abcabcabc";
    const out = redactGitOutput(`out ${"abc".repeat(5)} done`, [value]);
    expect(holdsValueFragment(out, [value])).toBe(false);
    expect(out === "out [REDACTED] done").toBe(true);
  });

  it("still redacts a value shorter than the sandbox redactor's minimum", () => {
    expect(redactGitOutput("x abcd y", ["abcd"]) === "x [REDACTED] y").toBe(true);
  });
});

describe("git-askpass.sh", () => {
  const askpass = fileURLToPath(new URL("../../../scripts/git-askpass.sh", import.meta.url));
  const username = (env: NodeJS.ProcessEnv) =>
    execFileSync("/bin/sh", [askpass, "Username for 'https://example.test': "], { env, encoding: "utf8" });

  it("defaults to GitHub's username", () => {
    expect(username({ PATH: "/usr/bin:/bin" })).toBe("x-access-token\n");
  });

  it("uses the remote's username when set", () => {
    expect(username({ PATH: "/usr/bin:/bin", WARDBY_GIT_USERNAME: "x-token-auth" })).toBe("x-token-auth\n");
  });
});

describe("NodeGitCommandRunner authUsername", () => {
  const fakeToken = "fake_token_value_0123456789";
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fakeGit(body: string[]): Promise<{ root: string; executable: string }> {
    const root = await mkdtemp(join(tmpdir(), "wardby-git-username-"));
    roots.push(root);
    const executable = resolve(root, "fake-git.mjs");
    await writeFile(
      executable,
      [`#!${process.execPath}`, "import { readFileSync } from 'node:fs';", ...body].join("\n"),
    );
    await chmod(executable, 0o700);
    return { root, executable };
  }

  it("refuses an unsafe username before running git", async () => {
    const runner = new NodeGitCommandRunner({ homeDir: tmpdir() });
    await expect(runner.run(["version"], { authToken: "a".repeat(20), authUsername: "bad name\n" })).rejects.toThrow(
      "git_auth_username_invalid",
    );
  });

  it("puts only the username in the environment, never the token", async () => {
    const { root, executable } = await fakeGit([
      "console.log(JSON.stringify({ username: process.env.WARDBY_GIT_USERNAME ?? null, env: JSON.stringify(process.env), fd3: readFileSync(3, 'utf8').trim() }));",
    ]);
    const runner = new NodeGitCommandRunner({ gitBinary: executable, homeDir: root });
    const withName = JSON.parse(
      (await runner.run(["status"], { authToken: fakeToken, authUsername: "x-token-auth" })).stdout,
    ) as { username: string | null; env: string; fd3: string };
    expect(withName.username).toBe("x-token-auth");
    expect(withName.env).not.toContain(fakeToken);
    expect(withName.fd3).toBe(fakeToken);
    const without = JSON.parse((await runner.run(["status"], { authToken: fakeToken })).stdout) as {
      username: string | null;
    };
    expect(without.username).toBeNull();
    // A username without a token is ignored: no credential flow, no variable.
    const noToken = await fakeGit(["console.log(String(process.env.WARDBY_GIT_USERNAME ?? null));"]);
    const bare = new NodeGitCommandRunner({ gitBinary: noToken.executable, homeDir: noToken.root });
    expect((await bare.run(["status"], { authUsername: "x-token-auth" })).stdout.trim()).toBe("null");
  });

  it("keeps a fake token out of git's output when the command fails", async () => {
    // The fake git prints the token it reads from fd 3 and the whole environment,
    // so the failure path really carries the token and only redaction hides it.
    const { root, executable } = await fakeGit([
      "console.error('token=' + readFileSync(3, 'utf8').trim() + ' env=' + JSON.stringify(process.env));",
      "process.exit(2);",
    ]);
    const runner = new NodeGitCommandRunner({ gitBinary: executable, homeDir: root });
    const error = await runner
      .run(["ls-remote", "origin", fakeToken], { authToken: fakeToken, authUsername: "x-token-auth" })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("token=[REDACTED]");
    expect(String(error)).toContain("x-token-auth");
    expect(String(error)).not.toContain(fakeToken);
  });
});

const FAKE_SECRET = "ghs_FAKEtoken0123456789abcdefABCDEF";

/** Real git over file:// bare repositories, through a fake GitRemote that hands out `token` (none by default). */
describe("GitVcsProvider per-repository workspaces (real git)", { timeout: 30_000 }, () => {
  const run = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    })
      .toString()
      .trim();

  interface Bare {
    repository: string;
    bare: string;
    commits: string[];
  }

  /** A bare repository `name` whose main has one commit per entry of `versions` (README.md holding it). */
  async function bareRepo(root: string, name: string, versions: string[] = ["v1\n", "v2\n"]): Promise<Bare> {
    const seed = resolve(root, `${name}-seed`);
    await mkdir(seed, { recursive: true });
    run(seed, ["init", "--quiet", "--initial-branch=main"]);
    const commits: string[] = [];
    for (const version of versions) {
      await writeFile(resolve(seed, "README.md"), version);
      run(seed, ["add", "README.md"]);
      run(seed, ["commit", "--quiet", "-m", version.trim()]);
      commits.push(run(seed, ["rev-parse", "HEAD"]));
    }
    const bare = resolve(root, `${name}.git`);
    run(root, ["clone", "--quiet", "--bare", seed, bare]);
    return { repository: `test/${name}`, bare, commits };
  }

  function fileRemote(bares: Bare[], token?: string): GitRemote {
    const byName = new Map(bares.map((entry) => [entry.repository, entry.bare]));
    return {
      gitConfig: ["-c", "protocol.file.allow=always"],
      normalizeRepository: (repository) => repository,
      cloneUrl: (repository) => {
        const bare = byName.get(repository);
        if (!bare) throw new Error("vcs_remote_invalid");
        return pathToFileURL(bare).href;
      },
      withAccess: (_repository, fn) => fn(token),
      withReadAccess: (_repository, fn) => fn(token),
      assertContinuationOpen: async () => undefined,
      publish: async ({ workspace }) => ({ kind: "branch", branch: workspace.headRef }),
      conflictError: () => new Error("conflict"),
    };
  }

  async function setup(token?: string, git?: GitCommandRunner) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "wardby-vcs-slots-")));
    roots.push(root);
    const main = await bareRepo(root, "app");
    const tools = await bareRepo(root, "tools");
    const base = await bareRepo(root, "base");
    const remote = fileRemote([main, tools, base], token);
    const rootDir = resolve(root, "vcs");
    const make = () => new GitVcsProvider({ rootDir, remote, ...(git ? { git } : {}) });
    const input: VcsPrepareInput = {
      runId: "run-1",
      repository: main.repository,
      baseRef: "main",
      headRef: "wardby/run-run-1",
      protectedPaths: [".github/workflows/**"],
    };
    return { root, rootDir, main, tools, base, remote, provider: make(), make, input };
  }

  async function namesUnder(directory: string): Promise<string[]> {
    const names: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) names.push(entry.name);
    return names;
  }

  it("prepares a writable slot beside the default, pushes its branch, and cleans up only the slot", async () => {
    const { rootDir, tools, provider, input } = await setup();
    const primary = await provider.prepareWorkspace(input);
    const slot = await provider.prepareWorkspace({ ...input, repository: tools.repository, slot: { name: "tools" } });
    expect(slot).toMatchObject({
      id: "vcs-run-1:tools",
      slot: { name: "tools" },
      workspacePath: resolve(rootDir, "run-1", "repos", "tools", "workspace"),
      gitMetadataPath: resolve(rootDir, "run-1", "repos", "tools", "git"),
      baseCommit: tools.commits.at(-1),
    });
    expect(slot).not.toHaveProperty("branchRunId");
    expect(await readFile(resolve(slot.workspacePath, "README.md"), "utf8")).toBe("v2\n");
    await writeFile(resolve(slot.workspacePath, "tool.txt"), "new\n");
    const result = await provider.finalizeChanges(slot);
    expect(result).toMatchObject({ outcome: "branch_pushed", headRef: "wardby/run-run-1" });
    expect(run(tools.bare, ["rev-parse", "refs/heads/wardby/run-run-1"])).toBe(
      (result as { commitSha: string }).commitSha,
    );

    await provider.cleanup(slot);
    expect(existsSync(resolve(rootDir, "run-1", "repos", "tools"))).toBe(false);
    expect(existsSync(primary.workspacePath)).toBe(true);
    expect(existsSync(primary.gitMetadataPath)).toBe(true);
    // A slot handle can't clean up the default, nor the default's handle a slot.
    await expect(provider.cleanup({ ...slot, workspacePath: primary.workspacePath })).rejects.toThrow(
      "vcs_workspace_handle_invalid",
    );
    await expect(provider.cleanup({ ...primary, slot: { name: "tools" } })).rejects.toThrow(
      "vcs_workspace_handle_invalid",
    );
  });

  it("refuses a slot before the default workspace exists, and a slot name that isn't a repository name", async () => {
    const { rootDir, tools, provider, input } = await setup();
    await expect(
      provider.prepareWorkspace({ ...input, repository: tools.repository, slot: { name: "tools" } }),
    ).rejects.toThrow("vcs_workspace_path_invalid");
    expect(existsSync(resolve(rootDir, "run-1"))).toBe(false);
    await provider.prepareWorkspace(input);
    for (const name of ["workspace", "../x", "Tools", ""]) {
      await expect(
        provider.prepareWorkspace({ ...input, repository: tools.repository, slot: { name } }),
      ).rejects.toThrow("vcs_slot_invalid");
    }
  });

  it("refuses a second slot of the same name and leaves the first intact", async () => {
    const { tools, provider, input } = await setup();
    await provider.prepareWorkspace(input);
    const slot = await provider.prepareWorkspace({ ...input, repository: tools.repository, slot: { name: "tools" } });
    await expect(
      provider.prepareWorkspace({ ...input, repository: tools.repository, slot: { name: "tools" } }),
    ).rejects.toThrow("vcs_workspace_exists");
    expect(existsSync(slot.workspacePath)).toBe(true);
  });

  it("recovers a slot from a fresh provider instance", async () => {
    const { tools, provider, make, input } = await setup();
    await provider.prepareWorkspace(input);
    const slotInput = { ...input, repository: tools.repository, slot: { name: "tools" } };
    const slot = await provider.prepareWorkspace(slotInput);
    await expect(make().recoverWorkspace(slotInput)).resolves.toEqual(slot);
    await expect(make().recoverWorkspace({ ...slotInput, slot: { name: "other" } })).resolves.toBeNull();
  });

  it("copies one commit read-only, with no git metadata left anywhere under the copy", async () => {
    const { rootDir, base, provider, input } = await setup();
    await provider.prepareWorkspace(input);
    const copy = await provider.prepareReadOnlyCopy({
      runId: "run-1",
      name: "base",
      repository: base.repository,
      commit: base.commits[0],
    });
    expect(copy).toEqual({
      runId: "run-1",
      name: "base",
      repository: base.repository,
      commit: base.commits[0],
      workspacePath: resolve(rootDir, "run-1", "repos", "base", "workspace"),
    });
    expect(await readFile(resolve(copy.workspacePath, "README.md"), "utf8")).toBe("v1\n");
    const names = await namesUnder(resolve(rootDir, "run-1", "repos", "base"));
    expect(names.sort()).toEqual(["README.md", "workspace"]);

    await provider.cleanupReadOnlyCopy(copy);
    expect(existsSync(resolve(rootDir, "run-1", "repos", "base"))).toBe(false);
    expect(existsSync(resolve(rootDir, "run-1", "workspace"))).toBe(true);
    await expect(provider.cleanupReadOnlyCopy({ ...copy, workspacePath: rootDir })).rejects.toThrow(
      "vcs_workspace_handle_invalid",
    );
  });

  it("fails a read-only copy of an unknown commit and removes what it started", async () => {
    const { rootDir, base, provider, input } = await setup();
    await provider.prepareWorkspace(input);
    await expect(
      provider.prepareReadOnlyCopy({
        runId: "run-1",
        name: "base",
        repository: base.repository,
        commit: "d".repeat(40),
      }),
    ).rejects.toThrow("vcs_read_only_fetch_failed");
    expect(existsSync(resolve(rootDir, "run-1", "repos", "base"))).toBe(false);
  });

  it("validates a read-only copy's input and needs the run's default workspace first", async () => {
    const { base, provider, input } = await setup();
    const copyInput = { runId: "run-1", name: "base", repository: base.repository, commit: base.commits[0] };
    await expect(provider.prepareReadOnlyCopy(copyInput)).rejects.toThrow("vcs_workspace_path_invalid");
    await provider.prepareWorkspace(input);
    for (const bad of [{ name: "workspace" }, { name: "../base" }, { commit: "main" }, { runId: "../run-1" }]) {
      await expect(provider.prepareReadOnlyCopy({ ...copyInput, ...bad })).rejects.toThrow(
        "vcs_read_only_input_invalid",
      );
    }
  });

  it("refuses a read-only copy holding a symlink out of the workspace", async () => {
    const { root, input } = await setup();
    const seed = resolve(root, "linky-seed");
    await mkdir(seed);
    run(seed, ["init", "--quiet", "--initial-branch=main"]);
    await symlink("/etc", resolve(seed, "etc-link"));
    run(seed, ["add", "etc-link"]);
    run(seed, ["commit", "--quiet", "-m", "link"]);
    const commit = run(seed, ["rev-parse", "HEAD"]);
    run(root, ["clone", "--quiet", "--bare", seed, resolve(root, "linky.git")]);
    const linky: Bare = { repository: "test/linky", bare: resolve(root, "linky.git"), commits: [commit] };
    const rootDir = resolve(root, "vcs-linky");
    const app = await bareRepo(root, "app2");
    const linkProvider = new GitVcsProvider({ rootDir, remote: fileRemote([linky, app]) });
    await linkProvider.prepareWorkspace({ ...input, repository: "test/app2" });
    await expect(
      linkProvider.prepareReadOnlyCopy({ runId: "run-1", name: "linky", repository: linky.repository, commit }),
    ).rejects.toThrow("vcs_symlink_escape");
    expect(existsSync(resolve(rootDir, "run-1", "repos", "linky"))).toBe(false);
  });

  it("refuses a read-only copy whose checkout holds a nested repository", async () => {
    // Git itself refuses to check out a path named .git, so this runner plants
    // one right after the copy's read-tree, as a hostile tree would need to.
    const real = new NodeGitCommandRunner({ homeDir: tmpdir() });
    const planting: GitCommandRunner = {
      async run(args, options) {
        const result = await real.run(args, options);
        if (args.includes("read-tree") && options?.cwd) {
          await mkdir(resolve(options.cwd, "vendor", ".git"), { recursive: true });
        }
        return result;
      },
    };
    const { rootDir, base, make, input } = await setup();
    await make().prepareWorkspace(input);
    const plantingProvider = new GitVcsProvider({ rootDir, remote: fileRemote([base]), git: planting });
    await expect(
      plantingProvider.prepareReadOnlyCopy({
        runId: "run-1",
        name: "base",
        repository: base.repository,
        commit: base.commits[0],
      }),
    ).rejects.toThrow("vcs_nested_repository");
    expect(existsSync(resolve(rootDir, "run-1", "repos", "base"))).toBe(false);
  });

  it("creates another run's branch when branchRunId names it, and carries branchRunId through recovery", async () => {
    const { main, provider, make, input } = await setup();
    const borrowed = { ...input, runId: "run-2", headRef: "wardby/run-root-1", branchRunId: "root-1" };
    const { branchRunId: _unused, ...withoutBranchRunId } = borrowed;
    await expect(provider.prepareWorkspace(withoutBranchRunId)).rejects.toThrow("vcs_head_ref_invalid");
    const prepared = await provider.prepareWorkspace(borrowed);
    expect(prepared).toMatchObject({
      branchRunId: "root-1",
      headRef: "wardby/run-root-1",
      baseCommit: main.commits[1],
    });
    expect(run(prepared.workspacePath, [`--git-dir=${prepared.gitMetadataPath}`, "symbolic-ref", "HEAD"])).toBe(
      "refs/heads/wardby/run-root-1",
    );
    const recovered = await make().recoverWorkspace(borrowed);
    expect(recovered?.branchRunId).toBe("root-1");
    expect(recovered).toEqual(prepared);
  });

  it("requires branchRunId to equal the continuation's root run when both are set", async () => {
    const { provider, input } = await setup();
    await expect(
      provider.prepareWorkspace({
        ...input,
        runId: "run-2",
        headRef: "wardby/run-root-1",
        continuation: { rootRunId: "root-1" },
        branchRunId: "other-1",
      }),
    ).rejects.toThrow("vcs_head_ref_invalid");
    await expect(
      provider.prepareWorkspace({ ...input, runId: "run-2", headRef: "wardby/run-root-1", branchRunId: "../x" }),
    ).rejects.toThrow("vcs_branch_run_id_invalid");
  });

  describe("keeps a fake token out of every failure (read and write extras)", () => {
    /** A git that fails clone and fetch printing the token it was handed, and succeeds otherwise. */
    async function leakyGit(root: string): Promise<GitCommandRunner> {
      const executable = resolve(root, "leaky-git.mjs");
      await writeFile(
        executable,
        [
          `#!${process.execPath}`,
          "import { readFileSync } from 'node:fs';",
          "const args = process.argv.slice(2);",
          "if (args.includes('clone') || args.includes('fetch')) {",
          "  let piped = '';",
          "  try { piped = readFileSync(3, 'utf8').trim(); } catch {}",
          `  console.error('fatal: could not read from https://x-access-token:' + piped + '@github.com/o/r.git (${FAKE_SECRET})');`,
          "  process.exit(128);",
          "}",
        ].join("\n"),
      );
      await chmod(executable, 0o700);
      return new NodeGitCommandRunner({ gitBinary: executable, homeDir: root });
    }

    function causes(error: unknown): unknown[] {
      const chain: unknown[] = [];
      for (let current = error; current !== undefined && chain.length < 10;) {
        chain.push(current);
        current = current instanceof Error ? current.cause : undefined;
      }
      return chain;
    }

    function expectNoSecret(error: unknown): void {
      expect(error).toBeInstanceOf(Error);
      for (const link of causes(error)) {
        expect(String(link)).not.toContain(FAKE_SECRET);
        expect(JSON.stringify(link)).not.toContain(FAKE_SECRET);
        expect((link as Error).stack ?? "").not.toContain(FAKE_SECRET);
        expect(holdsValueFragment(String(link), FAKE_SECRET)).toBe(false);
      }
    }

    it("for a writable slot whose clone fails", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "wardby-leaky-"));
      roots.push(scratch);
      const { rootDir, tools, make, input } = await setup(FAKE_SECRET, await leakyGit(scratch));
      await mkdir(resolve(rootDir, "run-1"), { recursive: true, mode: 0o700 });
      const error = await make()
        .prepareWorkspace({ ...input, repository: tools.repository, slot: { name: "tools" } })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(String(error)).toContain("git_command_failed:128");
      expect(String(error)).toContain("[REDACTED]");
      expectNoSecret(error);
      expect(existsSync(resolve(rootDir, "run-1", "repos", "tools"))).toBe(false);
      expect(existsSync(resolve(rootDir, "run-1"))).toBe(true);
    });

    it("for a read-only copy whose fetch fails", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "wardby-leaky-"));
      roots.push(scratch);
      const { rootDir, base, make } = await setup(FAKE_SECRET, await leakyGit(scratch));
      await mkdir(resolve(rootDir, "run-1"), { recursive: true, mode: 0o700 });
      const error = await make()
        .prepareReadOnlyCopy({ runId: "run-1", name: "base", repository: base.repository, commit: base.commits[0] })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(String(error)).toContain("vcs_read_only_fetch_failed");
      expect(String((error as Error).cause)).toContain("[REDACTED]");
      expectNoSecret(error);
      expect(existsSync(resolve(rootDir, "run-1", "repos", "base"))).toBe(false);
    });
  });
});

describe("GitHubRemote publish with branchRunId", () => {
  it("opens the pull request under the branch run's identity", async () => {
    const { provider, github, git, input } = await harness();
    git.headRef = "wardby/run-root-1";
    const prepared = await provider.prepareWorkspace({
      ...input,
      runId: "run-2",
      headRef: "wardby/run-root-1",
      branchRunId: "root-1",
    });
    expect(prepared.branchRunId).toBe("root-1");
    await provider.finalizeChanges(prepared);
    expect(github.pullRequestCalls).toHaveLength(1);
    expect(github.pullRequestCalls[0]).toMatchObject({ runId: "root-1", headRef: "wardby/run-root-1" });
  });
});

describe("countWorkspaceEntries", () => {
  it("counts every entry of several trees together, never following a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-count-entries-"));
    try {
      const [one, two] = [join(root, "one"), join(root, "two")];
      await mkdir(join(one, "dir"), { recursive: true });
      await writeFile(join(one, "dir", "a.txt"), "a");
      await mkdir(two);
      await writeFile(join(two, "b.txt"), "b");
      await symlink(root, join(two, "loop"));
      // one: dir, dir/a.txt; two: b.txt, loop (not followed) = 4.
      await expect(countWorkspaceEntries([one, two], 4)).resolves.toBeUndefined();
      await expect(countWorkspaceEntries([one, two], 3)).rejects.toThrow("vcs_workspace_entry_limit");
      await expect(countWorkspaceEntries([one], 3)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
