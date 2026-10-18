import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitVcsProvider } from "./git.js";
import { LocalRemote } from "./local-remote.js";
import type { PublishInput, PublishResult } from "./remote.js";
import type { PreparedWorkspace, VcsPrepareInput } from "./types.js";

const run = promisify(execFile);
const ROOT_RUN = "root";
const HEAD_REF = `wardby/run-${ROOT_RUN}`;

/** A local repository that behaves like a pull request host: the continuation's PR targets `base`. */
class PullRequestRemote extends LocalRemote {
  base: string | null = "main";
  lookups = 0;

  async pullRequestBase(input: { continuation?: { rootRunId: string } }): Promise<{ ref: string } | null> {
    this.lookups += 1;
    return input.continuation && this.base ? { ref: this.base } : null;
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

async function commit(src: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(src, path)), { recursive: true });
    await writeFile(join(src, path), content);
  }
  await git(src, ["add", "--all"]);
  await git(src, ["commit", "-m", message]);
}

interface Fixture {
  src: string;
  remote: PullRequestRemote;
  provider: GitVcsProvider;
}

/**
 * main: `history` commits, then the PR branch forks; main then gets `mainCommits`
 * more (the last with `mainFiles`), and the PR branch gets one with `prFiles`.
 */
async function fixture(
  options: {
    history?: number;
    mainCommits?: number;
    mainFiles?: Record<string, string>;
    prFiles?: Record<string, string>;
  } = {},
): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wardby-merge-target-")));
  cleanup.push(root);
  home = join(root, "home");
  await mkdir(home);
  const src = join(root, "repos", "src");
  await mkdir(src, { recursive: true });
  await git(src, ["init", "--initial-branch=main"]);
  await commit(src, { "shared.txt": "one\ntwo\nthree\n", ".github/workflows/ci.yml": "on: push\n" }, "start");
  for (let n = 0; n < (options.history ?? 2); n += 1) await commit(src, { "history.txt": `${n}\n` }, `history ${n}`);
  await git(src, ["branch", HEAD_REF]);
  for (let n = 0; n < (options.mainCommits ?? 1); n += 1) await commit(src, { "main.txt": `${n}\n` }, `main ${n}`);
  if (options.mainFiles) await commit(src, options.mainFiles, "main change");
  await git(src, ["checkout", "-q", HEAD_REF]);
  await commit(src, options.prFiles ?? { "pr.txt": "pr\n" }, "pr change");
  await git(src, ["checkout", "-q", "main"]);
  const remote = new PullRequestRemote({ roots: () => [join(root, "repos")] });
  return { src, remote, provider: new GitVcsProvider({ rootDir: join(root, "vcs"), remote }) };
}

function input(f: Fixture, overrides: Partial<VcsPrepareInput> = {}): VcsPrepareInput {
  return {
    runId: "r2",
    repository: `local:${f.src}`,
    baseRef: "main",
    headRef: HEAD_REF,
    protectedPaths: [".github/workflows/**"],
    continuation: { rootRunId: ROOT_RUN },
    ...overrides,
  };
}

async function parents(src: string, sha: string): Promise<string[]> {
  return (await git(src, ["rev-list", "--parents", "-n", "1", sha])).split(" ").slice(1);
}

describe("continuations merge the pull request's target branch (real git)", { timeout: 30_000 }, () => {
  it("merges a target that moved ahead, with no agent changes needed, and pushes a Wardby merge commit", async () => {
    const f = await fixture();
    const workspace = await f.provider.prepareWorkspace(input(f));
    const main = await git(f.src, ["rev-parse", "main"]);
    expect(workspace.baseCommit).toBe(await git(f.src, ["rev-parse", HEAD_REF]));
    expect(workspace.targetMerge).toEqual({ ref: "main", targetCommit: main, conflictedPaths: [] });
    // The worker sees both sides.
    expect(await readFile(join(workspace.workspacePath, "main.txt"), "utf8")).toBe("0\n");
    expect(await readFile(join(workspace.workspacePath, "pr.txt"), "utf8")).toBe("pr\n");

    const result = await f.provider.finalizeChanges(workspace);
    expect(result).toMatchObject({
      outcome: "pull_request_updated",
      baseCommit: workspace.baseCommit,
      targetMerge: { ref: "main", targetCommit: main, conflicts: 0 },
    });
    if (result.outcome !== "pull_request_updated") throw new Error("unreachable");
    expect(await git(f.src, ["rev-parse", HEAD_REF])).toBe(result.commitSha);
    expect(await parents(f.src, result.commitSha)).toEqual([workspace.baseCommit, main]);
    expect(await git(f.src, ["log", "-1", "--format=%an <%ae>|%cn|%s", result.commitSha])).toBe(
      `Wardby <wardby@users.noreply.github.com>|Wardby|Merge main into ${HEAD_REF} (Wardby run r2)`,
    );
  });

  it("leaves a branch that already contains its target exactly as before (no merge, no_changes)", async () => {
    const f = await fixture({ mainCommits: 0 });
    const workspace = await f.provider.prepareWorkspace(input(f));
    expect(workspace.targetMerge).toBeUndefined();
    await expect(f.provider.finalizeChanges(workspace)).resolves.toMatchObject({ outcome: "no_changes" });
  });

  it("does not merge a fresh run, a remote with no target, or a target that is the head itself", async () => {
    const f = await fixture();
    f.remote.base = null;
    expect((await f.provider.prepareWorkspace(input(f))).targetMerge).toBeUndefined();
    f.remote.base = HEAD_REF;
    expect((await f.provider.prepareWorkspace(input(f, { runId: "r3" }))).targetMerge).toBeUndefined();
    f.remote.base = "main";
    const lookups = f.remote.lookups;
    const fresh = await f.provider.prepareWorkspace(
      input(f, { runId: "r4", headRef: "wardby/run-r4", continuation: undefined }),
    );
    expect(fresh.targetMerge).toBeUndefined();
    expect(f.remote.lookups).toBe(lookups);
  });

  it("merges the PR's current base, not the run's stored baseRef (a retargeted or stacked PR)", async () => {
    const f = await fixture();
    await git(f.src, ["branch", "release/1", "main"]);
    await git(f.src, ["checkout", "-q", "release/1"]);
    await commit(f.src, { "release.txt": "r\n" }, "release change");
    await git(f.src, ["checkout", "-q", "main"]);
    f.remote.base = "release/1";
    const workspace = await f.provider.prepareWorkspace(input(f));
    expect(workspace.targetMerge?.ref).toBe("release/1");
    expect(workspace.baseRef).toBe("main");
    const result = await f.provider.finalizeChanges(workspace);
    if (result.outcome !== "pull_request_updated") throw new Error("unreachable");
    expect(await parents(f.src, result.commitSha)).toEqual([
      workspace.baseCommit,
      await git(f.src, ["rev-parse", "release/1"]),
    ]);
  });

  it("deepens a depth-1 clone until it finds the merge base", async () => {
    const f = await fixture({ history: 3, mainCommits: 90 });
    const workspace = await f.provider.prepareWorkspace(input(f));
    expect(workspace.targetMerge?.conflictedPaths).toEqual([]);
    await expect(f.provider.finalizeChanges(workspace)).resolves.toMatchObject({ outcome: "pull_request_updated" });
  });

  it("lists conflicted paths, refuses to push while markers remain, and pushes once they are resolved", async () => {
    const f = await fixture({
      mainFiles: { "shared.txt": "one\nMAIN\nthree\n" },
      prFiles: { "shared.txt": "one\nPR\nthree\n" },
    });
    const workspace = await f.provider.prepareWorkspace(input(f));
    expect(workspace.targetMerge?.conflictedPaths).toEqual(["shared.txt"]);
    const conflicted = await readFile(join(workspace.workspacePath, "shared.txt"), "utf8");
    expect(conflicted).toMatch(/^<<<<<<< /m);
    expect(conflicted).toMatch(/^>>>>>>> /m);

    await expect(f.provider.finalizeChanges(workspace)).rejects.toThrow("vcs_conflict_markers_remain:shared.txt");
    const before = await git(f.src, ["rev-parse", HEAD_REF]);
    expect(before).toBe(workspace.baseCommit);

    // Recovery reads the merge back from the workspace's git metadata.
    const recovered = await f.provider.recoverWorkspace(input(f));
    expect(recovered?.targetMerge).toEqual(workspace.targetMerge);

    await writeFile(join(workspace.workspacePath, "shared.txt"), "one\nPR and MAIN\nthree\n");
    const result = await f.provider.finalizeChanges(recovered!);
    expect(result).toMatchObject({ outcome: "pull_request_updated", targetMerge: { conflicts: 1 } });
    if (result.outcome !== "pull_request_updated") throw new Error("unreachable");
    expect(await git(f.src, ["show", `${result.commitSha}:shared.txt`])).toBe("one\nPR and MAIN\nthree");
  });

  it("ignores the repository's merge attributes (no repository-chosen marker size or merge strategy)", async () => {
    for (const attributes of ["* conflict-marker-size=9\n", "* -merge\n", "* merge=union\n"]) {
      const f = await fixture({
        mainFiles: { "shared.txt": "one\nMAIN\nthree\n" },
        prFiles: { "shared.txt": "one\nPR\nthree\n", ".gitattributes": attributes },
      });
      const workspace = await f.provider.prepareWorkspace(input(f));
      expect(workspace.targetMerge?.conflictedPaths, attributes).toEqual(["shared.txt"]);
      const conflicted = await readFile(join(workspace.workspacePath, "shared.txt"), "utf8");
      expect(conflicted, attributes).toMatch(/^<{7} /m);
      expect(conflicted, attributes).not.toMatch(/^<{8}/m);
      await expect(f.provider.finalizeChanges(workspace)).rejects.toThrow("vcs_conflict_markers_remain:shared.txt");
    }
  });

  it("lets the target's own protected-path change through, but refuses an agent edit to it", async () => {
    const f = await fixture({ mainFiles: { ".github/workflows/ci.yml": "on: pull_request\n" } });
    const workspace = await f.provider.prepareWorkspace(input(f));
    expect(await readFile(join(workspace.workspacePath, ".github/workflows/ci.yml"), "utf8")).toBe(
      "on: pull_request\n",
    );
    await expect(f.provider.finalizeChanges(workspace)).resolves.toMatchObject({ outcome: "pull_request_updated" });

    const g = await fixture({ mainFiles: { ".github/workflows/ci.yml": "on: pull_request\n" } });
    const reverting = await g.provider.prepareWorkspace(input(g));
    // Writing the branch's old version back reverts the target's change: an agent edit.
    await writeFile(join(reverting.workspacePath, ".github/workflows/ci.yml"), "on: push\n");
    await expect(g.provider.finalizeChanges(reverting)).rejects.toThrow("vcs_protected_path:.github/workflows/ci.yml");
  });

  it("measures the agent's changes only: a large target update does not count against its limits", async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`bulk/${n}.txt`, `${n}\n`]));
    const f = await fixture({ mainFiles: files });
    const limited = new GitVcsProvider({
      rootDir: join(dirname(dirname(f.src)), "vcs-limited"),
      remote: f.remote,
      maxChangedFiles: 5,
    });
    const workspace = await limited.prepareWorkspace(input(f));
    await writeFile(join(workspace.workspacePath, "agent.txt"), "agent\n");
    await expect(limited.finalizeChanges(workspace)).resolves.toMatchObject({ outcome: "pull_request_updated" });
  });

  it("still fails safely when someone else pushed to the PR branch meanwhile", async () => {
    const f = await fixture();
    const workspace = await f.provider.prepareWorkspace(input(f));
    await git(f.src, ["checkout", "-q", HEAD_REF]);
    await commit(f.src, { "person.txt": "pushed\n" }, "a person's push");
    await git(f.src, ["checkout", "-q", "main"]);
    await expect(f.provider.finalizeChanges(workspace)).rejects.toThrow("local_branch_conflict");
  });

  it("refuses a handle whose merge does not match the workspace's recorded one", async () => {
    const f = await fixture();
    const workspace: PreparedWorkspace = await f.provider.prepareWorkspace(input(f));
    await expect(
      f.provider.finalizeChanges({
        ...workspace,
        targetMerge: { ...workspace.targetMerge!, conflictedPaths: [], ref: "other" },
      }),
    ).rejects.toThrow("vcs_workspace_handle_invalid");
    const { targetMerge: _dropped, ...withoutMerge } = workspace;
    await expect(f.provider.finalizeChanges(withoutMerge)).rejects.toThrow("vcs_workspace_handle_invalid");
  });

  it("fails with vcs_target_merge_failed when the target shares no history with the branch", async () => {
    const f = await fixture();
    await git(f.src, ["checkout", "-q", "--orphan", "unrelated"]);
    await git(f.src, ["rm", "-rq", "--cached", "."]);
    await commit(f.src, { "other.txt": "x\n" }, "unrelated root");
    await git(f.src, ["checkout", "-q", "-f", "main"]);
    f.remote.base = "unrelated";
    await expect(f.provider.prepareWorkspace(input(f))).rejects.toThrow("vcs_target_merge_failed");
  });
});
