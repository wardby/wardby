import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitVcsProvider, NodeGitCommandRunner, type GitCommandOptions, type GitCommandRunner } from "./git.js";
import { LocalRemote } from "./local-remote.js";
import type { PreparedWorkspace, VcsPrepareInput } from "./types.js";

const run = promisify(execFile);
const WARDBY = "Wardby <wardby@users.noreply.github.com>";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let home = "";
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: home,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Person",
      GIT_AUTHOR_EMAIL: "person@example.invalid",
      GIT_COMMITTER_NAME: "Person",
      GIT_COMMITTER_EMAIL: "person@example.invalid",
    },
  });
  return stdout.trim();
}

async function write(repo: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(join(repo, file), content);
  }
}

async function commit(repo: string, files: Record<string, string>, message: string): Promise<string> {
  await write(repo, files);
  await git(repo, ["add", "--all"]);
  await git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

interface Fixture {
  root: string;
  upstream: string;
  fork: string;
  upstreamTip: string;
  provider: GitVcsProvider;
}

/**
 * upstream: shared (a.txt, ci.yml), then its tip (up.txt, and ci.yml changed). fork: shared, then
 * one commit of its own (fork.txt), on main.
 */
async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wardby-result-finalize-")));
  cleanup.push(root);
  home = join(root, "home");
  await mkdir(home);
  const upstream = join(root, "repos", "upstream");
  await mkdir(upstream, { recursive: true });
  await git(upstream, ["init", "-q", "--initial-branch=main"]);
  const shared = await commit(upstream, { "a.txt": "a\n", ".github/workflows/ci.yml": "ci\n" }, "shared");
  const upstreamTip = await commit(
    upstream,
    { "up.txt": "up\n", ".github/workflows/ci.yml": "ci upstream\n" },
    "upstream changes ci",
  );
  const fork = join(root, "repos", "fork");
  await git(join(root, "repos"), ["clone", "-q", upstream, fork]);
  await git(fork, ["reset", "-q", "--hard", shared]);
  await git(fork, ["remote", "remove", "origin"]);
  await commit(fork, { "fork.txt": "fork\n" }, "fork");
  const remote = new LocalRemote({ roots: () => [join(root, "repos")] });
  return { root, upstream, fork, upstreamTip, provider: new GitVcsProvider({ rootDir: join(root, "vcs"), remote }) };
}

function input(f: Fixture, overrides: Partial<VcsPrepareInput> = {}): VcsPrepareInput {
  return {
    runId: "r1",
    repository: `local:${f.fork}`,
    baseRef: "main",
    headRef: "wardby/run-r1",
    protectedPaths: [".github/workflows/**"],
    gitHistory: { depth: "full" },
    remotes: [{ name: "upstream", repository: `local:${f.upstream}`, resolvedSha: f.upstreamTip, label: "main" }],
    ...overrides,
  };
}

/** Git as the agent runs it, in the worker's .git. */
const agent = (prepared: PreparedWorkspace, args: string[]) =>
  git(prepared.workspacePath, [
    `--git-dir=${join(prepared.workspacePath, ".git")}`,
    `--work-tree=${prepared.workspacePath}`,
    ...args,
  ]);

async function agentCommit(prepared: PreparedWorkspace, files: Record<string, string>, message: string) {
  await write(prepared.workspacePath, files);
  await agent(prepared, ["add", "--all"]);
  await agent(prepared, ["commit", "-q", "-m", message]);
  return agent(prepared, ["rev-parse", "HEAD"]);
}

/** What the worker and the collector do: the bundle beside the workspace, and the worker's .git gone. */
async function collect(f: Fixture, prepared: PreparedWorkspace): Promise<string> {
  const bundle = join(f.root, "result-bundles", "workspace.bundle");
  await mkdir(dirname(bundle), { recursive: true, mode: 0o700 });
  await agent(prepared, ["update-ref", "refs/wardby/bundle-head", "HEAD"]);
  await agent(prepared, [
    "bundle",
    "create",
    "-q",
    bundle,
    "refs/wardby/bundle-head",
    "--not",
    prepared.historyBase!,
    ...prepared.remoteTips!,
  ]);
  await rm(join(prepared.workspacePath, ".git"), { recursive: true, force: true });
  return bundle;
}

/** A fork whose main is upstream's parent of the tip, so that the tip is a fast-forward of base. */
async function forkBehindUpstream(f: Fixture): Promise<void> {
  await git(f.fork, ["reset", "-q", "--hard", `${f.upstreamTip}^`]);
}

/** What the worker driver bundles when the agent only fast-forwarded onto a remote tip: head --not base. */
async function collectFastForward(f: Fixture, prepared: PreparedWorkspace): Promise<string> {
  const bundle = join(f.root, "result-bundles", "workspace.bundle");
  await mkdir(dirname(bundle), { recursive: true, mode: 0o700 });
  await agent(prepared, ["update-ref", "refs/wardby/bundle-head", "HEAD"]);
  await agent(prepared, ["bundle", "create", "-q", bundle, "refs/wardby/bundle-head", "--not", prepared.historyBase!]);
  await rm(join(prepared.workspacePath, ".git"), { recursive: true, force: true });
  return bundle;
}

/** The git subcommand of a control-plane call: the first argument that is neither a flag nor a -c value. */
function subcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-c") index += 1;
    else if (!args[index].startsWith("-")) return args[index];
  }
  return undefined;
}

const controlGit = (prepared: PreparedWorkspace, args: string[]) =>
  git(prepared.workspacePath, [`--git-dir=${prepared.gitMetadataPath}`, ...args]);

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("finalizing a history run from its result bundle (real git, #536)", { timeout: 60_000 }, () => {
  it("pushes the agent's rewritten commits, then the uncommitted files as one commit on top", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f));
    const first = await agentCommit(prepared, { "b.txt": "b\n" }, "add b");
    const second = await agentCommit(prepared, { "c.txt": "c\n" }, "add c");
    await write(prepared.workspacePath, { "d.txt": "uncommitted\n" });
    const resultBundle = await collect(f, prepared);

    const finalized = await f.provider.finalizeChanges(prepared, { resultBundle });
    expect(finalized).toMatchObject({ outcome: "branch_pushed", baseCommit: prepared.baseCommit });
    const pushed = (finalized as { commitSha: string }).commitSha;
    expect(await git(f.fork, ["rev-parse", "wardby/run-r1"])).toBe(pushed);
    expect(await controlGit(prepared, ["rev-parse", "refs/wardby/result"])).toBe(pushed);
    const rewrittenTip = await controlGit(prepared, ["rev-parse", "refs/wardby/result-rewritten"]);
    const log = (await git(f.fork, ["log", "--format=%H %P|%an <%ae>|%s", `${prepared.baseCommit}..wardby/run-r1`]))
      .split("\n")
      .map((line) => line.split("|"));
    expect(log.map(([, , subject]) => subject)).toEqual(["Wardby run r1", "add c", "add b"]);
    expect(log.every(([, author]) => author === WARDBY)).toBe(true);
    expect(log[0][0].split(" ")).toEqual([pushed, rewrittenTip]);
    expect(log.map(([shas]) => shas).join(" ")).not.toContain(first);
    expect(log.map(([shas]) => shas).join(" ")).not.toContain(second);
    expect(await git(f.fork, ["show", "wardby/run-r1:d.txt"])).toBe("uncommitted");

    // The state a finalize leaves is one recovery accepts, and finalizing again pushes the same tip.
    const recovered = await f.provider.recoverWorkspace(input(f));
    expect(recovered).toEqual(prepared);
    await expect(f.provider.finalizeChanges(recovered!)).resolves.toMatchObject({ commitSha: pushed });
  });

  it("imports into a shallow history (a depth, not full)", async () => {
    const f = await fixture();
    for (let n = 1; n <= 5; n += 1) await commit(f.fork, { "fork.txt": `${n}\n` }, `fork ${n}`);
    const prepared = await f.provider.prepareWorkspace(input(f, { gitHistory: { depth: 2 }, remotes: [] }));
    expect(await controlGit(prepared, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    await agentCommit(prepared, { "b.txt": "b\n" }, "add b");
    await agentCommit(prepared, { "c.txt": "c\n" }, "add c");
    const resultBundle = await collect(f, prepared);
    const finalized = await f.provider.finalizeChanges(prepared, { resultBundle });
    expect(finalized.outcome).toBe("branch_pushed");
    expect(await git(f.fork, ["rev-list", "--count", `${prepared.baseCommit}..wardby/run-r1`])).toBe("2");
  });

  it("pushes the rewritten tip itself when nothing is left uncommitted", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f));
    await agentCommit(prepared, { "b.txt": "b\n" }, "add b");
    const resultBundle = await collect(f, prepared);
    const finalized = await f.provider.finalizeChanges(prepared, { resultBundle });
    const rewrittenTip = await controlGit(prepared, ["rev-parse", "refs/wardby/result-rewritten"]);
    expect(finalized).toMatchObject({ outcome: "branch_pushed", commitSha: rewrittenTip });
  });

  it("refuses an agent commit that changes a protected path", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f));
    await agentCommit(prepared, { ".github/workflows/x.yml": "evil\n" }, "workflow");
    // A later commit undoing it does not help: every commit's own paths are the agent's.
    await rm(join(prepared.workspacePath, ".github/workflows/x.yml"));
    await agent(prepared, ["add", "--all"]);
    await agent(prepared, ["commit", "-q", "-m", "undo"]);
    const resultBundle = await collect(f, prepared);
    expect((await errorOf(f.provider.finalizeChanges(prepared, { resultBundle }))).message).toBe(
      "vcs_protected_path:.github/workflows/x.yml",
    );
    expect(await git(f.fork, ["branch", "--list", "wardby/run-r1"])).toBe("");
  });

  it("allows a protected path that only the upstream tip changed, brought in unchanged by a merge", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f));
    await agent(prepared, ["merge", "-q", "--no-edit", "refs/remotes/upstream/main"]);
    const resultBundle = await collect(f, prepared);
    const finalized = await f.provider.finalizeChanges(prepared, { resultBundle });
    expect(finalized.outcome).toBe("branch_pushed");
    expect(await git(f.fork, ["show", "wardby/run-r1:.github/workflows/ci.yml"])).toBe("ci upstream");
    const parents = (await git(f.fork, ["rev-list", "--parents", "-n", "1", "wardby/run-r1"])).split(" ");
    expect(parents.slice(1)).toEqual([prepared.baseCommit, f.upstreamTip]);
  });

  it("refuses a merge that resolves a protected path to content different from every parent", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f));
    await agent(prepared, ["merge", "-q", "--no-commit", "refs/remotes/upstream/main"]);
    await write(prepared.workspacePath, { ".github/workflows/ci.yml": "neither parent\n" });
    await agent(prepared, ["add", "--all"]);
    await agent(prepared, ["commit", "-q", "--no-edit"]);
    const resultBundle = await collect(f, prepared);
    expect((await errorOf(f.provider.finalizeChanges(prepared, { resultBundle }))).message).toBe(
      "vcs_protected_path:.github/workflows/ci.yml",
    );
  });

  it("refuses conflict markers left in a path a merge commit resolved", async () => {
    const f = await fixture();
    await commit(f.fork, { "up.txt": "fork side\n" }, "fork touches up.txt");
    const prepared = await f.provider.prepareWorkspace(input(f));
    await agent(prepared, ["merge", "-q", "--no-edit", "refs/remotes/upstream/main"]).catch(() => undefined);
    expect(await readFile(join(prepared.workspacePath, "up.txt"), "utf8")).toContain("<<<<<<<");
    await agent(prepared, ["add", "--all"]);
    await agent(prepared, ["commit", "-q", "--no-edit"]);
    const resultBundle = await collect(f, prepared);
    expect((await errorOf(f.provider.finalizeChanges(prepared, { resultBundle }))).message).toBe(
      "vcs_conflict_markers_remain:up.txt",
    );
  });

  it("counts the agent's commit diffs and the uncommitted diff together against the diff limit", async () => {
    const f = await fixture();
    const provider = new GitVcsProvider({
      rootDir: join(f.root, "vcs"),
      remote: new LocalRemote({ roots: () => [join(f.root, "repos")] }),
      maxDiffBytes: 3000,
    });
    const prepared = await provider.prepareWorkspace(input(f));
    await agentCommit(prepared, { "b.txt": "b".repeat(1600) }, "b");
    await write(prepared.workspacePath, { "c.txt": "c".repeat(1600) });
    const resultBundle = await collect(f, prepared);
    expect((await errorOf(provider.finalizeChanges(prepared, { resultBundle }))).message).toBe("vcs_diff_size_limit");
  });

  it("without a bundle, commits the uncommitted files on the history base", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f));
    await write(prepared.workspacePath, { "b.txt": "b\n" });
    await rm(join(prepared.workspacePath, ".git"), { recursive: true });
    const finalized = await f.provider.finalizeChanges(prepared);
    const pushed = (finalized as { commitSha: string }).commitSha;
    expect(await git(f.fork, ["rev-list", "--parents", "-n", "1", pushed])).toBe(`${pushed} ${prepared.baseCommit}`);
    await expect(f.provider.recoverWorkspace(input(f))).resolves.toEqual(prepared);
  });

  it("without a bundle or any change, pushes a continuation's pending target merge (M0)", async () => {
    const f = await fixture();
    await git(f.fork, ["branch", "wardby/run-root"]);
    await commit(f.fork, { "main.txt": "main moved\n" }, "main moves on");
    // A continuation's host: its pull request targets main.
    const remote = new (class extends LocalRemote {
      async pullRequestBase(): Promise<{ ref: string }> {
        return { ref: "main" };
      }
    })({ roots: () => [join(f.root, "repos")] });
    const provider = new GitVcsProvider({ rootDir: join(f.root, "vcs"), remote });
    const continuation = input(f, {
      runId: "r2",
      headRef: "wardby/run-root",
      continuation: { rootRunId: "root" },
    });
    const prepared = await provider.prepareWorkspace(continuation);
    expect(prepared.historyBase).not.toBe(prepared.baseCommit);
    await rm(join(prepared.workspacePath, ".git"), { recursive: true });
    const finalized = await provider.finalizeChanges(prepared);
    expect(finalized).toMatchObject({ commitSha: prepared.historyBase });
    expect(await git(f.fork, ["rev-parse", "wardby/run-root"])).toBe(prepared.historyBase);
  });

  it("without a bundle, commits a continuation's uncommitted files on top of M0", async () => {
    const f = await fixture();
    await git(f.fork, ["branch", "wardby/run-root"]);
    await commit(f.fork, { "main.txt": "main moved\n" }, "main moves on");
    const remote = new (class extends LocalRemote {
      async pullRequestBase(): Promise<{ ref: string }> {
        return { ref: "main" };
      }
    })({ roots: () => [join(f.root, "repos")] });
    const provider = new GitVcsProvider({ rootDir: join(f.root, "vcs"), remote });
    const continuation = input(f, { runId: "r2", headRef: "wardby/run-root", continuation: { rootRunId: "root" } });
    const prepared = await provider.prepareWorkspace(continuation);
    await write(prepared.workspacePath, { "b.txt": "b\n" });
    await rm(join(prepared.workspacePath, ".git"), { recursive: true });
    const finalized = await provider.finalizeChanges(prepared);
    const pushed = (finalized as { commitSha: string }).commitSha;
    expect(await git(f.fork, ["rev-list", "--parents", "-n", "1", pushed])).toBe(`${pushed} ${prepared.historyBase}`);
  });

  it("pushes a fast-forward onto the upstream tip as is: upstream's protected changes are not the agent's", async () => {
    const f = await fixture();
    await forkBehindUpstream(f);
    const prepared = await f.provider.prepareWorkspace(input(f));
    await agent(prepared, ["merge", "-q", "--ff-only", "refs/remotes/upstream/main"]);
    const resultBundle = await collectFastForward(f, prepared);
    const finalized = await f.provider.finalizeChanges(prepared, { resultBundle });
    expect(finalized).toMatchObject({ outcome: "branch_pushed", commitSha: f.upstreamTip });
    expect(await git(f.fork, ["rev-parse", "wardby/run-r1"])).toBe(f.upstreamTip);
    expect(await controlGit(prepared, ["rev-parse", "refs/wardby/result"])).toBe(f.upstreamTip);
    await expect(f.provider.recoverWorkspace(input(f))).resolves.toEqual(prepared);
  });

  it("commits the uncommitted files on top of a fast-forwarded upstream tip", async () => {
    const f = await fixture();
    await forkBehindUpstream(f);
    const prepared = await f.provider.prepareWorkspace(input(f));
    await agent(prepared, ["merge", "-q", "--ff-only", "refs/remotes/upstream/main"]);
    await write(prepared.workspacePath, { "b.txt": "b\n" });
    const resultBundle = await collectFastForward(f, prepared);
    const finalized = await f.provider.finalizeChanges(prepared, { resultBundle });
    const pushed = (finalized as { commitSha: string }).commitSha;
    expect(await git(f.fork, ["rev-list", "--parents", "-n", "1", pushed])).toBe(`${pushed} ${f.upstreamTip}`);
    expect(await git(f.fork, ["show", "-s", "--format=%an <%ae>|%s", pushed])).toBe(`${WARDBY}|Wardby run r1`);
  });

  it("still refuses a protected path the agent changed on top of a fast-forward", async () => {
    const f = await fixture();
    await forkBehindUpstream(f);
    const prepared = await f.provider.prepareWorkspace(input(f));
    await agent(prepared, ["merge", "-q", "--ff-only", "refs/remotes/upstream/main"]);
    await write(prepared.workspacePath, { ".github/workflows/ci.yml": "agent\n" });
    const resultBundle = await collectFastForward(f, prepared);
    expect((await errorOf(f.provider.finalizeChanges(prepared, { resultBundle }))).message).toBe(
      "vcs_protected_path:.github/workflows/ci.yml",
    );
  });

  it("bounds every git call that reads or writes a tree from the bundle by a timeout, on finalize and re-push", async () => {
    const f = await fixture();
    const inner = new NodeGitCommandRunner({ homeDir: join(f.root, "vcs", ".home") });
    let recording = false;
    const seen: { command: string | undefined; timeoutMs: number | undefined }[] = [];
    const runner: GitCommandRunner = {
      run(args: readonly string[], options?: GitCommandOptions) {
        if (recording) seen.push({ command: subcommand(args), timeoutMs: options?.timeoutMs });
        return inner.run(args, options);
      },
    };
    const remote = new LocalRemote({ roots: () => [join(f.root, "repos")] });
    const provider = new GitVcsProvider({ rootDir: join(f.root, "vcs"), remote, git: runner });
    const prepared = await provider.prepareWorkspace(input(f));
    await agentCommit(prepared, { "b.txt": "b\n" }, "add b");
    await write(prepared.workspacePath, { "c.txt": "c\n" });
    const resultBundle = await collect(f, prepared);
    recording = true;
    await provider.finalizeChanges(prepared, { resultBundle });
    // Finalized again without a bundle: the recorded tip is pushed again.
    await provider.finalizeChanges(prepared);
    recording = false;
    const treeCalls = seen.filter(({ command }) =>
      ["read-tree", "add", "diff", "write-tree", "commit-tree"].includes(command ?? ""),
    );
    expect(new Set(treeCalls.map(({ command }) => command))).toEqual(
      new Set(["read-tree", "add", "diff", "write-tree", "commit-tree"]),
    );
    expect(treeCalls.filter(({ timeoutMs }) => !(typeof timeoutMs === "number" && timeoutMs > 0))).toEqual([]);
  });

  it("finalizes a continuation's history run from a bundle on top of M0", async () => {
    const f = await fixture();
    await git(f.fork, ["branch", "wardby/run-root"]);
    await commit(f.fork, { "main.txt": "main moved\n" }, "main moves on");
    const remote = new (class extends LocalRemote {
      async pullRequestBase(): Promise<{ ref: string }> {
        return { ref: "main" };
      }
    })({ roots: () => [join(f.root, "repos")] });
    const provider = new GitVcsProvider({ rootDir: join(f.root, "vcs"), remote });
    const continuation = input(f, { runId: "r2", headRef: "wardby/run-root", continuation: { rootRunId: "root" } });
    const prepared = await provider.prepareWorkspace(continuation);
    await agentCommit(prepared, { "b.txt": "b\n" }, "add b");
    const resultBundle = await collect(f, prepared);
    const finalized = await provider.finalizeChanges(prepared, { resultBundle });
    const pushed = (finalized as { commitSha: string }).commitSha;
    expect((await git(f.fork, ["rev-list", "--parents", "-n", "1", pushed])).split(" ")[1]).toBe(prepared.historyBase);
  });
});
