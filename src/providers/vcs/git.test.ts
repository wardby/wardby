import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  NodeGitCommandRunner,
  protectedPathMatcher,
  redactGitOutput,
  type GitCommandOptions,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git.js";
import { GitHubRemote } from "./github-remote.js";
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
    if (command === "rev-parse") {
      const revision = copied.at(-1)!;
      if (revision.startsWith("refs/remotes/origin/")) return { stdout: `${BASE_SHA}\n`, stderr: "" };
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
