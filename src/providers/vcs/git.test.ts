import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ContinuationCheckRunCompleteInput,
  ContinuationCheckRunInput,
  ContinuationStatusCommentInput,
  GitHubRepositoryAccess,
  PullRequestInput,
  PullRequestResult,
} from "./github.js";
import {
  GitCommandError,
  GitVcsProvider,
  NodeGitCommandRunner,
  redactGitOutput,
  type GitCommandOptions,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git.js";
import type { VcsPrepareInput } from "./types.js";

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

  async withRepositoryToken<T>(_repository: string, action: (token: string) => Promise<T>): Promise<T> {
    this.tokenCalls += 1;
    return action(TOKEN);
  }

  async createOrFindDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    this.pullRequestCalls.push(structuredClone(input));
    return { number: 42, url: "https://github.com/openai/example/pull/42" };
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
  headRef = "reevo/run-run-1";

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
      if (this.pushFails) throw new GitCommandError(1, "push rejected");
      this.remoteSha = this.headSha;
    }
    return { stdout: "", stderr: "" };
  }
}

const roots: string[] = [];

async function harness(overrides: Partial<ConstructorParameters<typeof GitVcsProvider>[0]> = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "reevo-vcs-test-"));
  roots.push(rootDir);
  const github = new FakeGitHub();
  const git = new ScriptedGitRunner();
  const provider = new GitVcsProvider({ rootDir, github, git, ...overrides });
  const input: VcsPrepareInput = {
    runId: "run-1",
    repository: REPOSITORY,
    baseRef: "main",
    headRef: "reevo/run-run-1",
    protectedPaths: [".github/workflows/**", "CODEOWNERS"],
  };
  return { rootDir, github, git, provider, input };
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
      headRef: "reevo/run-run-1",
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

  it("commits with controlled settings, pushes once, and creates one typed draft PR result", async () => {
    const { provider, github, git, input } = await harness();
    const prepared = await provider.prepareWorkspace(input);
    await writeFile(resolve(prepared.workspacePath, "src-index.ts"), "changed\n");

    await expect(provider.finalizeChanges(prepared)).resolves.toEqual({
      outcome: "pull_request_opened",
      repository: REPOSITORY,
      baseRef: "main",
      baseCommit: BASE_SHA,
      headRef: "reevo/run-run-1",
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
    expect(push.args).toContain(`${COMMIT_SHA}:refs/heads/reevo/run-run-1`);
    expect(github.pullRequestCalls).toHaveLength(1);
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
        headRef: "reevo/run-run-1",
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
        headRef: "reevo/run-run-1",
        baseCommit: BASE_SHA,
        continuation: { rootRunId: "run-1" },
      });
      const clone = git.calls.find((call) => call.args.includes("clone"))!;
      const branchFlagIndex = clone.args.indexOf("--branch");
      expect(clone.args[branchFlagIndex + 1]).toBe("reevo/run-run-1");

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
        headRef: "reevo/run-run-1",
        commitSha: COMMIT_SHA,
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/openai/example/pull/42",
      });
      // PR identity is keyed to the ROOT run's id, not this (continuation) run's own.
      expect(github.pullRequestCalls[0]).toMatchObject({ runId: "run-1", headRef: "reevo/run-run-1" });
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
              headRef: "reevo/run-run-1",
              body: "🔄 reevo run run-2 is working on this PR...",
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
              headRef: "reevo/run-run-1",
              body: "✅ reevo run run-2 finished.",
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
          "🔄 knock-knock-implement (reevo run run-2) is working on this PR...",
        );
      });

      it("includes the agent name in the done comment too, particularly useful for the cross-agent case", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "succeeded", { agentName: "knock-knock-implement" });

        expect(github.statusCommentCalls[0].input.body).toBe("✅ knock-knock-implement (reevo run run-2) finished.");
      });

      it("includes the agent's own summary in the done comment when given one", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "succeeded", {
          summary: "Added timestamped logging for every served joke.",
        });

        expect(github.statusCommentCalls[0].input.body).toBe(
          "✅ reevo run run-2 finished.\n\nAdded timestamped logging for every served joke.",
        );
      });

      it("omits the summary suffix entirely when none is given", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "failed", {});

        expect(github.statusCommentCalls[0].input.body).toBe("❌ reevo run run-2 failed.");
      });

      it("uses a failed-shaped body/outcome when the run failed", async () => {
        const { provider, github } = await harness();
        const prepared = await provider.prepareWorkspace(continuationInput());

        await provider.notifyContinuationFinished(prepared, "failed");

        expect(github.statusCommentCalls[0].input.body).toBe("❌ reevo run run-2 failed.");
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
    const root = await mkdtemp(join(tmpdir(), "reevo-git-runner-"));
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
    const root = await mkdtemp(join(tmpdir(), "reevo-git-runner-"));
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
        response.writeHead(401, { "www-authenticate": "Basic realm=reevo-test" });
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
      const root = await mkdtemp(join(tmpdir(), "reevo-git-runner-"));
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
