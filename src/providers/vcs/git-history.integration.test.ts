import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitVcsProvider } from "./git.js";
import { LocalRemote } from "./local-remote.js";
import type { PublishInput, PublishResult } from "./remote.js";
import type { VcsPrepareInput } from "./types.js";

const run = promisify(execFile);
/** A fake installation token (never a real one): what a GitHub remote would hand git. */
const FAKE_TOKEN = "ghs_FAKEtokenForTheWorkerGitScan0123456789";

/**
 * A local repository that hands git a token the way GitHubRemote does (file:// ignores it), and
 * behaves like a pull request host for continuations: the PR targets `main`.
 */
class TokenRemote extends LocalRemote {
  tokensHanded = 0;

  override withAccess<T>(repository: string, fn: (token: string | undefined) => Promise<T>): Promise<T> {
    return super.withAccess(repository, () => {
      this.tokensHanded += 1;
      return fn(FAKE_TOKEN);
    });
  }

  override withReadAccess<T>(repository: string, fn: (token: string | undefined) => Promise<T>): Promise<T> {
    return this.withAccess(repository, fn);
  }

  async pullRequestBase(input: { continuation?: { rootRunId: string } }): Promise<{ ref: string } | null> {
    return input.continuation ? { ref: "main" } : null;
  }

  override async publish({ workspace }: PublishInput): Promise<PublishResult> {
    this.assertPushRef(workspace.headRef);
    return { kind: "pull_request", number: 7, url: "https://github.com/your-org/your-repo/pull/7" };
  }
}

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

async function commit(repo: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, file), content);
  await git(repo, ["add", "--all"]);
  await git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Every file under `dir`, recursively (symlinks are not followed). */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

interface Fixture {
  upstream: string;
  fork: string;
  upstreamTip: string;
  forkPoint: string;
  remote: TokenRemote;
  provider: GitVcsProvider;
}

interface Shape {
  shared?: number;
  upstreamAhead?: number;
  forkAhead?: number;
}

/**
 * upstream: `shared` + `upstreamAhead` commits on main (default 2 + 3). fork: upstream's first
 * `shared`, then `forkAhead` (default 3) of its own on main.
 */
async function fixture({ shared = 2, upstreamAhead = 3, forkAhead = 3 }: Shape = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wardby-git-history-")));
  cleanup.push(root);
  home = join(root, "home");
  await mkdir(home);
  const upstream = join(root, "repos", "upstream");
  await mkdir(upstream, { recursive: true });
  await git(upstream, ["init", "-q", "--initial-branch=main"]);
  const upstreamCommits: string[] = [];
  for (let n = 1; n <= shared + upstreamAhead; n += 1)
    upstreamCommits.push(await commit(upstream, "up.txt", `${n}\n`, `upstream ${n}`));
  const fork = join(root, "repos", "fork");
  await git(join(root, "repos"), ["clone", "-q", upstream, fork]);
  await git(fork, ["reset", "-q", "--hard", upstreamCommits[shared - 1]]);
  await git(fork, ["remote", "remove", "origin"]);
  for (let n = 1; n <= forkAhead; n += 1) await commit(fork, "fork.txt", `${n}\n`, `fork ${n}`);
  const remote = new TokenRemote({ roots: () => [join(root, "repos")] });
  return {
    upstream,
    fork,
    upstreamTip: upstreamCommits[shared + upstreamAhead - 1],
    forkPoint: upstreamCommits[shared - 1],
    remote,
    provider: new GitVcsProvider({ rootDir: join(root, "vcs"), remote }),
  };
}

function input(f: Fixture, overrides: Partial<VcsPrepareInput> = {}): VcsPrepareInput {
  return {
    runId: "r1",
    repository: `local:${f.fork}`,
    baseRef: "main",
    headRef: "wardby/run-r1",
    protectedPaths: [".github/workflows/**"],
    remotes: [{ name: "upstream", repository: `local:${f.upstream}`, resolvedSha: f.upstreamTip, label: "main" }],
    ...overrides,
  };
}

const workerGit = (workspacePath: string, args: string[]) =>
  git(workspacePath, [`--git-dir=${join(workspacePath, ".git")}`, ...args]);

describe("git history runs: prepare (real git, #536)", { timeout: 30_000 }, () => {
  it("clones to depth, fetches the remote link, and gives the worker a shallow .git with both", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f, { gitHistory: { depth: 3 } }));
    const ws = prepared.workspacePath;
    expect(await workerGit(ws, ["rev-list", "--count", "HEAD"])).toBe("3");
    expect(await workerGit(ws, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(await workerGit(ws, ["rev-parse", "refs/remotes/upstream/main"])).toBe(f.upstreamTip);
    expect(await workerGit(ws, ["symbolic-ref", "HEAD"])).toBe("refs/heads/wardby/run-r1");
    expect(await workerGit(ws, ["rev-parse", "HEAD"])).toBe(prepared.baseCommit);
    // The index matches the checked-out files: git in the workspace sees a clean tree.
    expect(await git(ws, ["status", "--porcelain"])).toBe("");
    // A whole repository: every object there, the shallow boundary recorded, packed as one pack.
    await workerGit(ws, ["fsck", "--no-progress", "--strict"]);
    const packs = (await readdir(join(ws, ".git", "objects", "pack"))).filter((name) => name.endsWith(".pack"));
    expect(packs).toHaveLength(1);
    expect(prepared).toMatchObject({
      gitHistory: { depth: 3 },
      historyBase: prepared.baseCommit,
      remoteTips: [f.upstreamTip],
    });
    // No sample hooks, no reflog naming the control plane's git dir, one pack.
    const files = await filesUnder(join(ws, ".git"));
    expect(files.some((file) => file.includes(`${join(ws, ".git", "hooks")}`))).toBe(false);
    expect(files.some((file) => file.includes(join(ws, ".git", "logs")))).toBe(false);
    for (const file of files) expect(await readFile(file, "latin1")).not.toContain(prepared.gitMetadataPath);
    await expect(f.provider.recoverWorkspace(input(f, { gitHistory: { depth: 3 } }))).resolves.toEqual(prepared);
  });

  it("with full history has the whole fork and a merge base with the remote", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f, { gitHistory: { depth: "full" } }));
    const ws = prepared.workspacePath;
    expect(await workerGit(ws, ["rev-list", "--count", "HEAD"])).toBe(
      await git(f.fork, ["rev-list", "--count", "HEAD"]),
    );
    expect(await workerGit(ws, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(await workerGit(ws, ["merge-base", "HEAD", "upstream/main"])).toBe(f.forkPoint);
  });

  it("puts no credential anywhere in the worker .git: every byte scanned for a fake token", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepareWorkspace(input(f, { gitHistory: { depth: "full" } }));
    // The token really was handed to git (clone and remote fetch), so the scan means something.
    expect(f.remote.tokensHanded).toBeGreaterThanOrEqual(2);
    const files = await filesUnder(join(prepared.workspacePath, ".git"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = await readFile(file);
      expect(bytes.includes(Buffer.from(FAKE_TOKEN))).toBe(false);
      expect(bytes.includes(Buffer.from("x-access-token"))).toBe(false);
    }
    const config = await readFile(join(prepared.workspacePath, ".git", "config"), "utf8");
    expect(config).not.toMatch(/url|remote|credential|http/i);
  });

  it("commits a continuation's target merge as M0, with two parents, and starts the worker there", async () => {
    const f = await fixture();
    // The continuation's branch, from the fork's main; then main moves on.
    await git(f.fork, ["branch", "wardby/run-root"]);
    await git(f.fork, ["checkout", "-q", "wardby/run-root"]);
    await commit(f.fork, "pr.txt", "pr\n", "pr change");
    await git(f.fork, ["checkout", "-q", "main"]);
    const targetCommit = await commit(f.fork, "main.txt", "main moved\n", "main moves on");
    const continuation = input(f, {
      runId: "r2",
      headRef: "wardby/run-root",
      continuation: { rootRunId: "root" },
      gitHistory: { depth: 10 },
    });
    const prepared = await f.provider.prepareWorkspace(continuation);
    const ws = prepared.workspacePath;
    expect(prepared.targetMerge).toMatchObject({ ref: "main", targetCommit, conflictedPaths: [] });
    expect(prepared.historyBase).not.toBe(prepared.baseCommit);
    expect(await workerGit(ws, ["rev-parse", "HEAD"])).toBe(prepared.historyBase);
    expect((await workerGit(ws, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(" ")).toEqual([
      prepared.historyBase,
      prepared.baseCommit,
      targetCommit,
    ]);
    expect(await git(ws, ["status", "--porcelain"])).toBe("");
    expect(await readFile(join(ws, "main.txt"), "utf8")).toBe("main moved\n");
    await expect(f.provider.recoverWorkspace(continuation)).resolves.toEqual(prepared);
  });

  it("keeps the head's full depth when a remote is further ahead than the fork but closer than the depth", async () => {
    // Upstream 6 past the shared base, the fork 3 past it, depth 10: a depth-10 fetch of upstream
    // alone would cut the fork's own history to 7 commits (the shallow boundary is repository-wide).
    const f = await fixture({ shared: 12, upstreamAhead: 6, forkAhead: 3 });
    const prepared = await f.provider.prepareWorkspace(input(f, { gitHistory: { depth: 10 } }));
    const ws = prepared.workspacePath;
    // Deepening only adds history, so the head may end with more than the depth, never fewer.
    expect(Number(await workerGit(ws, ["rev-list", "--count", "HEAD"]))).toBeGreaterThanOrEqual(10);
    expect(
      Number(await git(ws, [`--git-dir=${prepared.gitMetadataPath}`, "rev-list", "--count", "HEAD"])),
    ).toBeGreaterThanOrEqual(10);
    expect(await workerGit(ws, ["rev-parse", "refs/remotes/upstream/main"])).toBe(f.upstreamTip);
    expect(await workerGit(ws, ["rev-parse", "HEAD"])).toBe(prepared.baseCommit);
    expect(await git(ws, [`--git-dir=${prepared.gitMetadataPath}`, "rev-parse", "refs/remotes/origin/main"])).toBe(
      prepared.baseCommit,
    );
  });

  it("keeps the head's full depth when a continuation's target is further ahead than the head's branch", async () => {
    // The branch is 2 past main's old tip, main then moves 6; depth 10 from the target would cut the branch's history.
    const f = await fixture({ shared: 12, upstreamAhead: 0, forkAhead: 0 });
    await git(f.fork, ["checkout", "-q", "-b", "wardby/run-root"]);
    await commit(f.fork, "pr.txt", "1\n", "pr 1");
    const branchTip = await commit(f.fork, "pr.txt", "2\n", "pr 2");
    await git(f.fork, ["checkout", "-q", "main"]);
    for (let n = 1; n <= 6; n += 1) await commit(f.fork, "main.txt", `${n}\n`, `main ${n}`);
    const prepared = await f.provider.prepareWorkspace(
      input(f, {
        runId: "r2",
        headRef: "wardby/run-root",
        continuation: { rootRunId: "root" },
        gitHistory: { depth: 10 },
        remotes: [],
      }),
    );
    expect(prepared.baseCommit).toBe(branchTip);
    const count = async (dir: string) =>
      Number(await git(prepared.workspacePath, [`--git-dir=${dir}`, "rev-list", "--count", branchTip]));
    // Deepening only adds history, so the head may end with more than the depth, never fewer.
    expect(await count(join(prepared.workspacePath, ".git"))).toBeGreaterThanOrEqual(10);
    expect(await count(prepared.gitMetadataPath)).toBeGreaterThanOrEqual(10);
  });
  it("keeps a continuation's merge base when it lies deeper than the depth (restoring only adds history)", async () => {
    // Shared 40, the branch 12 ahead, main 2 ahead, depth 5: the deepen loop has to take the head
    // well past 5 commits to reach the merge base, and restoring the head's window must not undo it.
    const f = await fixture({ shared: 40, upstreamAhead: 0, forkAhead: 0 });
    await git(f.fork, ["checkout", "-q", "-b", "wardby/run-root"]);
    let branchTip = "";
    for (let n = 1; n <= 12; n += 1) branchTip = await commit(f.fork, "pr.txt", `${n}\n`, `pr ${n}`);
    await git(f.fork, ["checkout", "-q", "main"]);
    let targetCommit = "";
    for (let n = 1; n <= 2; n += 1) targetCommit = await commit(f.fork, "main.txt", `${n}\n`, `main ${n}`);
    const prepared = await f.provider.prepareWorkspace(
      input(f, {
        runId: "r2",
        headRef: "wardby/run-root",
        continuation: { rootRunId: "root" },
        gitHistory: { depth: 5 },
        remotes: [],
      }),
    );
    expect(prepared.baseCommit).toBe(branchTip);
    expect(prepared.targetMerge).toMatchObject({ ref: "main", targetCommit });
    const ws = prepared.workspacePath;
    expect((await workerGit(ws, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(" ")).toEqual([
      prepared.historyBase,
      branchTip,
      targetCommit,
    ]);
    const count = async (dir: string) => Number(await git(ws, [`--git-dir=${dir}`, "rev-list", "--count", branchTip]));
    expect(await count(join(ws, ".git"))).toBeGreaterThanOrEqual(5);
    expect(await count(prepared.gitMetadataPath)).toBeGreaterThanOrEqual(5);
    expect(await workerGit(ws, ["merge-base", branchTip, targetCommit])).toBe(f.forkPoint);
  });

  it("never shortens a remote link inside the head's history while restoring the head's window", async () => {
    // Upstream's tip is the fork's tip~3, depth 10: upstream's own fetch gives it 10 commits.
    const f = await fixture({ shared: 12, upstreamAhead: 0, forkAhead: 3 });
    const prepared = await f.provider.prepareWorkspace(input(f, { gitHistory: { depth: 10 } }));
    const ws = prepared.workspacePath;
    const count = async (dir: string, rev: string) =>
      Number(await git(ws, [`--git-dir=${dir}`, "rev-list", "--count", rev]));
    for (const dir of [join(ws, ".git"), prepared.gitMetadataPath]) {
      expect(await count(dir, "HEAD")).toBeGreaterThanOrEqual(10);
      expect(await count(dir, "refs/remotes/upstream/main")).toBeGreaterThanOrEqual(10);
    }
    expect(await workerGit(ws, ["rev-parse", "refs/remotes/upstream/main"])).toBe(f.upstreamTip);
  });
});
