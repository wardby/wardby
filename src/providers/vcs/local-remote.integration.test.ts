import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitVcsProvider, NodeGitCommandRunner, type GitCommandRunner } from "./git.js";
import { LocalRemote } from "./local-remote.js";
import type { PreparedWorkspace, VcsPrepareInput } from "./types.js";

const run = promisify(execFile);

interface Fixture {
  root: string;
  reposRoot: string;
  src: string;
  roots: string[];
  provider: GitVcsProvider;
}

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

let fixtureHome = "";
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "commit.gpgSign=false", ...args], { cwd, env: isolatedEnv(fixtureHome) });
  return stdout.trim();
}

async function makeRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "--initial-branch=main"]);
  await writeFile(join(path, "README.md"), "hello\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "c1"]);
  await writeFile(join(path, "README.md"), "hello again\n");
  await git(path, ["commit", "-am", "c2"]);
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wardby-local-remote-")));
  cleanup.push(root);
  fixtureHome = join(root, "home");
  await mkdir(fixtureHome);
  const reposRoot = join(root, "repos");
  const src = join(reposRoot, "src");
  await makeRepo(src);
  await writeFile(join(src, ".env.local"), "SECRET=do-not-copy\n");
  const roots = [reposRoot];
  const provider = new GitVcsProvider({
    rootDir: join(root, "vcs"),
    remote: new LocalRemote({ roots: () => roots }),
  });
  return { root, reposRoot, src, roots, provider };
}

function input(f: Fixture, overrides: Partial<VcsPrepareInput> = {}): VcsPrepareInput {
  return {
    runId: "r1",
    repository: `local:${f.src}`,
    baseRef: "main",
    headRef: "wardby/run-r1",
    protectedPaths: [".github/workflows/**", "CODEOWNERS"],
    ...overrides,
  };
}

async function snapshot(src: string): Promise<Record<string, string>> {
  return {
    head: await git(src, ["symbolic-ref", "HEAD"]),
    status: await git(src, ["status", "--porcelain", "--untracked-files=all"]),
    env: await readFile(join(src, ".env.local"), "utf8"),
    config: await readFile(join(src, ".git", "config"), "utf8"),
    readme: await readFile(join(src, "README.md"), "utf8"),
  };
}

async function prepareAndChange(f: Fixture, overrides: Partial<VcsPrepareInput> = {}): Promise<PreparedWorkspace> {
  const workspace = await f.provider.prepareWorkspace(input(f, overrides));
  await writeFile(join(workspace.workspacePath, `change-${workspace.runId}.txt`), `${workspace.runId}\n`);
  return workspace;
}

describe("LocalRemote (real git, no Docker)", { timeout: 20_000 }, () => {
  it("has no description refresh (a local repository has no pull requests), and the provider answers undefined", async () => {
    const f = await fixture();
    expect(new LocalRemote({ roots: () => [] })).not.toHaveProperty("refreshDescription");
    const workspace = await prepareAndChange(f);
    await expect(
      f.provider.refreshPullRequestDescription?.(workspace, {
        description: { baseline: { recordedSha256: null, agentTextRunId: "r1" } },
      }),
    ).resolves.toBeUndefined();
  });

  it("clones a local repository and pushes the run's branch back to it", async () => {
    const f = await fixture();
    const workspace = await prepareAndChange(f);
    expect(workspace.baseCommit).toBe(await git(f.src, ["rev-parse", "main"]));
    const result = await f.provider.finalizeChanges(workspace);
    expect(result).toMatchObject({
      outcome: "branch_pushed",
      repository: `local:${f.src}`,
      baseRef: "main",
      baseCommit: workspace.baseCommit,
      headRef: "wardby/run-r1",
    });
    if (result.outcome !== "branch_pushed") throw new Error("unreachable");
    expect(await git(f.src, ["rev-parse", "wardby/run-r1"])).toBe(result.commitSha);
    expect(await git(f.src, ["rev-parse", `${result.commitSha}^`])).toBe(workspace.baseCommit);
  });

  it("leaves the source checkout's HEAD, status, untracked files and config byte-identical", async () => {
    const f = await fixture();
    const before = await snapshot(f.src);
    const workspace = await prepareAndChange(f);
    await f.provider.finalizeChanges(workspace);
    await f.provider.cleanup(workspace);
    expect(await snapshot(f.src)).toEqual(before);
  });

  it("never copies untracked files from the source into the workspace", async () => {
    const f = await fixture();
    const workspace = await f.provider.prepareWorkspace(input(f));
    expect(existsSync(join(workspace.workspacePath, ".env.local"))).toBe(false);
    expect(existsSync(join(workspace.workspacePath, "README.md"))).toBe(true);
  });

  it("rejects a planted .git in the workspace without ever running its config or hooks", async () => {
    const f = await fixture();
    const workspace = await prepareAndChange(f);
    const pwned = join(f.root, `pwned-${Math.random().toString(36).slice(2)}`);
    const planted = join(workspace.workspacePath, ".git");
    await mkdir(join(planted, "hooks"), { recursive: true });
    await writeFile(join(planted, "config"), `[core]\n\tfsmonitor = touch ${pwned}\n`);
    await writeFile(join(planted, "hooks", "post-commit"), `#!/bin/sh\ntouch ${pwned}\n`, { mode: 0o755 });
    // Mirrors the GitHub path: inspectWorkspace refuses any .git entry.
    await expect(f.provider.finalizeChanges(workspace)).rejects.toThrow("vcs_nested_repository");
    expect(existsSync(pwned)).toBe(false);
    expect(await git(f.src, ["branch", "--list", "wardby/*"])).toBe("");
  });

  it("continues a pushed branch and refuses when the branch moved underneath the run", async () => {
    const f = await fixture();
    const first = await prepareAndChange(f);
    const r1 = await f.provider.finalizeChanges(first);
    if (r1.outcome !== "branch_pushed") throw new Error("expected branch_pushed");

    const continuation = { headRef: "wardby/run-r1", continuation: { rootRunId: "r1" } };
    const second = await prepareAndChange(f, { runId: "r2", ...continuation });
    expect(second.baseCommit).toBe(r1.commitSha);
    const r2 = await f.provider.finalizeChanges(second);
    if (r2.outcome !== "branch_pushed") throw new Error("expected branch_pushed");
    expect(r2.headRef).toBe("wardby/run-r1");
    expect(await git(f.src, ["rev-parse", "wardby/run-r1"])).toBe(r2.commitSha);
    expect(await git(f.src, ["rev-parse", `${r2.commitSha}^`])).toBe(r1.commitSha);

    const third = await prepareAndChange(f, { runId: "r3", ...continuation });
    await git(f.src, ["branch", "--force", "wardby/run-r1", "main"]);
    const moved = await git(f.src, ["rev-parse", "wardby/run-r1"]);
    await expect(f.provider.finalizeChanges(third)).rejects.toMatchObject({ code: "local_branch_conflict" });
    expect(await git(f.src, ["rev-parse", "wardby/run-r1"])).toBe(moved);
  });

  it("reports a hook-rejected continuation push as the push's own failure, not local_branch_conflict", async () => {
    const f = await fixture();
    const first = await prepareAndChange(f);
    const r1 = await f.provider.finalizeChanges(first);
    if (r1.outcome !== "branch_pushed") throw new Error("expected branch_pushed");

    const second = await prepareAndChange(f, {
      runId: "r2",
      headRef: "wardby/run-r1",
      continuation: { rootRunId: "r1" },
    });
    await writeFile(join(f.src, ".git", "hooks", "pre-receive"), "#!/bin/sh\necho 'policy says no' >&2\nexit 1\n", {
      mode: 0o755,
    });
    const error = await f.provider.finalizeChanges(second).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ code: "local_branch_conflict" });
    expect((error as Error).message).not.toContain("local_branch_conflict");
    expect(await git(f.src, ["rev-parse", "wardby/run-r1"])).toBe(r1.commitSha);
  });

  it("maps a push that loses a race to local_branch_conflict", async () => {
    const f = await fixture();
    const workspace = await prepareAndChange(f);
    const inner = new NodeGitCommandRunner({ homeDir: join(f.root, "vcs", ".home") });
    const racing: GitCommandRunner = {
      async run(args, options) {
        if (args.includes("push")) {
          // Another writer creates the branch (unrelated history) between ls-remote and push.
          const tree = await git(f.src, ["rev-parse", "main^{tree}"]);
          const orphan = await git(f.src, ["commit-tree", tree, "-m", "orphan"]);
          await git(f.src, ["update-ref", "refs/heads/wardby/run-r1", orphan]);
        }
        return inner.run(args, options);
      },
    };
    const provider = new GitVcsProvider({
      rootDir: join(f.root, "vcs"),
      remote: new LocalRemote({ roots: () => f.roots }),
      git: racing,
    });
    await expect(provider.finalizeChanges(workspace)).rejects.toMatchObject({ code: "local_branch_conflict" });
  });

  it("refuses to push a branch that is checked out in the source repository", async () => {
    const f = await fixture();
    const workspace = await prepareAndChange(f);
    await git(f.src, ["checkout", "-b", "wardby/run-r1"]);
    const before = await snapshot(f.src);
    const error = await f.provider.finalizeChanges(workspace).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "local_branch_conflict" });
    expect((error as Error).message).toContain("checked out");
    expect(await snapshot(f.src)).toEqual(before);
    expect(await git(f.src, ["rev-parse", "wardby/run-r1"])).toBe(workspace.baseCommit);
  });

  it("refuses to push a branch that is checked out in a linked worktree of the source repository", async () => {
    const f = await fixture();
    const workspace = await prepareAndChange(f);
    const linked = join(f.root, "linked-worktree");
    await git(f.src, ["worktree", "add", "-b", "wardby/run-r1", linked, "main"]);
    const error = await f.provider.finalizeChanges(workspace).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "local_branch_conflict" });
    expect((error as Error).message).toContain("checked out");
    expect(await git(f.src, ["rev-parse", "wardby/run-r1"])).toBe(workspace.baseCommit);
    expect(await git(linked, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a repository outside the roots, and roots that changed before finalize", async () => {
    const f = await fixture();
    const outside = join(f.root, "elsewhere", "other");
    await makeRepo(outside);
    await expect(f.provider.prepareWorkspace(input(f, { repository: `local:${outside}` }))).rejects.toMatchObject({
      code: "local_repo_not_allowed",
    });

    const workspace = await prepareAndChange(f);
    f.roots.splice(0, f.roots.length, join(f.root, "elsewhere"));
    await expect(f.provider.finalizeChanges(workspace)).rejects.toMatchObject({ code: "local_repo_not_allowed" });
    expect(await git(f.src, ["branch", "--list", "wardby/*"])).toBe("");
  });

  it("reports a missing base ref or continuation branch as local_ref_not_found", async () => {
    const f = await fixture();
    await expect(f.provider.prepareWorkspace(input(f, { baseRef: "does-not-exist" }))).rejects.toMatchObject({
      code: "local_ref_not_found",
    });
    await expect(
      f.provider.prepareWorkspace(
        input(f, { runId: "r2", headRef: "wardby/run-r1", continuation: { rootRunId: "r1" } }),
      ),
    ).rejects.toMatchObject({ code: "local_ref_not_found" });
    expect(existsSync(join(f.root, "vcs", "r1"))).toBe(false);
    expect(existsSync(join(f.root, "vcs", "r2"))).toBe(false);
  });

  it("refuses a repository named through a symlink, since the clone URL is built from the name", async () => {
    const f = await fixture();
    const alias = join(f.reposRoot, "alias");
    await symlink(f.src, alias);
    await expect(f.provider.prepareWorkspace(input(f, { repository: `local:${alias}` }))).rejects.toMatchObject({
      code: "local_repo_not_allowed",
    });
  });
});

describe("LocalRemote push guard", { timeout: 20_000 }, () => {
  const remote = new LocalRemote({ roots: () => [] });

  it("accepts only wardby/run-* refs", () => {
    expect(() => remote.assertPushRef("wardby/run-abc_1-2")).not.toThrow();
    for (const ref of [
      "main",
      "wardby/run-",
      "wardby/run-a/b",
      "refs/heads/wardby/run-a",
      "wardby/run-a..b",
      "x/wardby/run-a",
    ]) {
      expect(() => remote.assertPushRef(ref)).toThrow("vcs_head_ref_invalid");
    }
  });

  it("sets protocol.file.allow only through its own gitConfig and builds file:// URLs", () => {
    expect(remote.gitConfig).toEqual(["-c", "protocol.file.allow=always"]);
    expect(remote.cloneUrl("local:/tmp/a b")).toBe("file:///tmp/a%20b");
  });

  describe("readRepositoryFile", () => {
    const read = (
      f: Fixture,
      over: Partial<{ repository: string; ref: string; path: string; maxBytes: number }> = {},
    ) =>
      f.provider.readRepositoryFile({
        repository: `local:${f.src}`,
        ref: "main",
        path: ".wardby/services.yaml",
        maxBytes: 8192,
        ...over,
      });

    it("reads a committed file at the ref, exactly", async () => {
      const f = await fixture();
      await mkdir(join(f.src, ".wardby"));
      await writeFile(join(f.src, ".wardby", "services.yaml"), "services:\n  db:\n    image: postgres\n");
      await git(f.src, ["add", ".wardby/services.yaml"]);
      await git(f.src, ["commit", "-m", "services"]);
      expect(await read(f)).toBe("services:\n  db:\n    image: postgres\n");
    });

    it("returns null when the file is absent at the ref", async () => {
      const f = await fixture();
      expect(await read(f)).toBeNull();
    });

    it("returns null for a file present only in the working tree, and ignores working-tree edits", async () => {
      const f = await fixture();
      await mkdir(join(f.src, ".wardby"));
      await writeFile(join(f.src, ".wardby", "services.yaml"), "uncommitted\n");
      expect(await read(f)).toBeNull();
      expect(await read(f, { path: "README.md" })).toBe("hello again\n");
      await writeFile(join(f.src, "README.md"), "edited\n");
      expect(await read(f, { path: "README.md" })).toBe("hello again\n");
    });

    it("rejects traversal paths and option-like refs", async () => {
      const f = await fixture();
      await expect(read(f, { path: "../x" })).rejects.toThrow();
      await expect(read(f, { path: "a/./b" })).rejects.toThrow();
      await expect(read(f, { path: "/etc/passwd" })).rejects.toThrow();
      await expect(read(f, { ref: "--output=/tmp/x" })).rejects.toThrow();
    });

    it("reports a missing ref as local_ref_not_found", async () => {
      const f = await fixture();
      await expect(read(f, { ref: "nope" })).rejects.toMatchObject({ code: "local_ref_not_found" });
    });

    it("refuses a repository outside the roots", async () => {
      const f = await fixture();
      const other = join(f.root, "other");
      await makeRepo(other);
      await expect(read(f, { repository: `local:${other}` })).rejects.toMatchObject({
        code: "local_repo_not_allowed",
      });
    });

    it("refuses a non-UTF-8 file and a non-file entry", async () => {
      const f = await fixture();
      await writeFile(join(f.src, "bin.dat"), Buffer.from([0xff, 0xfe, 0x41]));
      await symlink("README.md", join(f.src, "link"));
      await git(f.src, ["add", "bin.dat", "link"]);
      await git(f.src, ["commit", "-m", "more"]);
      await expect(read(f, { path: "bin.dat" })).rejects.toThrow("local_file_not_utf8");
      await expect(read(f, { path: "link" })).rejects.toThrow("local_file_not_a_file");
    });

    it("refuses a file above maxBytes", async () => {
      const f = await fixture();
      await expect(read(f, { path: "README.md", maxBytes: 3 })).rejects.toThrow("local_file_too_large");
    });
  });
});
