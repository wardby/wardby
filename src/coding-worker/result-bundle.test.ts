import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLE_HEAD_REF,
  RESULT_BUNDLE_NAME,
  createResultBundle,
  gitAvailable,
  readHeadCommit,
  resolveHistoryPath,
} from "./result-bundle.mjs";

// ---------------------------------------------------------------- fixtures

let root: string;
let home: string;

/** Real git with no user or system config, so only each test's own repository config applies. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function gitStatus(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function commitFile(repo: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, name), content);
  git(repo, "add", name);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/**
 * Like the control plane's worker `.git`: a shallow, depth-1 clone of `upstream` at its `main`
 * (the base commit), on branch `wardby/run-x`.
 */
async function shallowWorkRepo(): Promise<{ upstream: string; work: string; base: string }> {
  const upstream = join(root, "upstream");
  await mkdir(upstream);
  git(upstream, "init", "-q", "-b", "main");
  await commitFile(upstream, "a.txt", "one\n", "first");
  await commitFile(upstream, "a.txt", "two\n", "second");
  const base = await commitFile(upstream, "a.txt", "three\n", "base");
  const work = join(root, "work");
  git(root, "clone", "-q", "--depth", "1", "--no-local", `file://${upstream}`, work);
  git(work, "checkout", "-q", "-b", "wardby/run-x");
  return { upstream, work, base };
}

/** The bundle file's prerequisite commits (header lines starting with "-"). */
async function bundlePrerequisites(bundle: string): Promise<string[]> {
  const text = (await readFile(bundle)).toString("latin1");
  const header = text.slice(0, text.indexOf("\n\n"));
  return header
    .split("\n")
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1, 41));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wardby-result-bundle-test-"));
  home = join(root, "home");
  await mkdir(home);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- readHeadCommit

describe("readHeadCommit", () => {
  it("reads a branch HEAD from its loose ref file", async () => {
    const { work } = await shallowWorkRepo();
    const head = await commitFile(work, "b.txt", "b\n", "agent");
    expect(await readHeadCommit(join(work, ".git"))).toBe(head);
  });

  it("reads a detached HEAD (a raw SHA)", async () => {
    const { work, base } = await shallowWorkRepo();
    git(work, "checkout", "-q", "--detach");
    expect(await readFile(join(work, ".git", "HEAD"), "utf8")).toBe(`${base}\n`);
    expect(await readHeadCommit(join(work, ".git"))).toBe(base);
  });

  it("reads a ref that exists only in packed-refs", async () => {
    const { work } = await shallowWorkRepo();
    const head = await commitFile(work, "b.txt", "b\n", "agent");
    git(work, "pack-refs", "--all");
    expect(await exists(join(work, ".git", "refs", "heads", "wardby", "run-x"))).toBe(false);
    expect(await readHeadCommit(join(work, ".git"))).toBe(head);
  });

  it("refuses a HEAD that is a symlink", async () => {
    const { work } = await shallowWorkRepo();
    const target = join(root, "elsewhere-HEAD");
    await writeFile(target, await readFile(join(work, ".git", "HEAD")));
    await rm(join(work, ".git", "HEAD"));
    await symlink(target, join(work, ".git", "HEAD"));
    expect(await readHeadCommit(join(work, ".git"))).toBeNull();
  });

  it("refuses a ref file that is a symlink, and packed-refs that is one", async () => {
    const { work, base } = await shallowWorkRepo();
    const ref = join(work, ".git", "refs", "heads", "wardby", "run-x");
    const target = join(root, "elsewhere-ref");
    await writeFile(target, `${base}\n`);
    await rm(ref);
    await symlink(target, ref);
    expect(await readHeadCommit(join(work, ".git"))).toBeNull();

    await rm(ref);
    const packed = join(work, ".git", "packed-refs");
    await rm(packed, { force: true });
    const packedTarget = join(root, "elsewhere-packed");
    await writeFile(packedTarget, `${base} refs/heads/wardby/run-x\n`);
    await symlink(packedTarget, packed);
    expect(await readHeadCommit(join(work, ".git"))).toBeNull();
  });

  it("refuses a ref directory that is a symlink", async () => {
    const { work, base } = await shallowWorkRepo();
    const outside = join(root, "outside-refs");
    await mkdir(outside);
    await writeFile(join(outside, "run-x"), `${base}\n`);
    await rm(join(work, ".git", "refs", "heads", "wardby"), { recursive: true });
    await symlink(outside, join(work, ".git", "refs", "heads", "wardby"));
    expect(await readHeadCommit(join(work, ".git"))).toBeNull();
  });

  it("refuses garbage, a ref name with '..', a symbolic ref chain and an oversized HEAD", async () => {
    const { work, base } = await shallowWorkRepo();
    const headPath = join(work, ".git", "HEAD");
    for (const text of [
      "garbage\n",
      "ref: refs/heads/../../config\n",
      "ref: /etc/passwd\n",
      `${base.slice(0, 39)}\n`,
      `${base.toUpperCase()}\n`,
      "",
    ]) {
      await writeFile(headPath, text);
      expect(await readHeadCommit(join(work, ".git"))).toBeNull();
    }
    await writeFile(join(work, ".git", "refs", "heads", "chain"), "ref: refs/heads/wardby/run-x\n");
    await writeFile(headPath, "ref: refs/heads/chain\n");
    expect(await readHeadCommit(join(work, ".git"))).toBeNull();
    await writeFile(headPath, `${base}\n${" ".repeat(64 * 1024)}`);
    expect(await readHeadCommit(join(work, ".git"))).toBeNull();
  });

  it("refuses a .git that is a symlink, and returns null when there is none", async () => {
    const { work } = await shallowWorkRepo();
    const linked = join(root, "linked");
    await mkdir(linked);
    await symlink(join(work, ".git"), join(linked, ".git"));
    expect(await readHeadCommit(join(linked, ".git"))).toBeNull();
    expect(await readHeadCommit(join(root, "missing", ".git"))).toBeNull();
  });
});

// ---------------------------------------------------------------- createResultBundle

describe("createResultBundle", () => {
  it("stops a slow bundle at its timeout and leaves no partial bundle file behind", async () => {
    const { work, base } = await shallowWorkRepo();
    await commitFile(work, "b.txt", "b\n", "agent");
    // A git that writes part of a bundle to stdout, then hangs on `git bundle create`.
    const wrapper = join(root, "slow-git.sh");
    await writeFile(
      wrapper,
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = bundle ]; then printf 'partial'; exec sleep 30; fi; done\nexec git "$@"\n`,
      { mode: 0o755 },
    );
    const started = Date.now();
    await expect(
      createResultBundle({
        repoPath: work,
        baseCommit: base,
        excludeCommits: [],
        gitBinary: wrapper,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/^result_bundle_git_failed$/);
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(lstat(join(work, ".git", RESULT_BUNDLE_NAME))).rejects.toThrow();
    expect(await readdir(join(work, ".git"))).not.toContain(`${RESULT_BUNDLE_NAME}.lock`);
  });

  it("bundles the new commits: the head is listed, and the bundle verifies once the base is present", async () => {
    const { upstream, work, base } = await shallowWorkRepo();
    await commitFile(work, "b.txt", "b\n", "agent one");
    const head = await commitFile(work, "c.txt", "c\n", "agent two");

    expect(await createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [] })).toEqual({
      bundled: true,
      head,
    });
    const bundle = join(work, ".git", RESULT_BUNDLE_NAME);
    expect((await lstat(bundle)).isFile()).toBe(true);
    expect(await bundlePrerequisites(bundle)).toEqual([base]);

    const fresh = join(root, "fresh");
    await mkdir(fresh);
    git(fresh, "init", "-q");
    expect(git(fresh, "bundle", "list-heads", bundle)).toBe(`${head} ${BUNDLE_HEAD_REF}`);
    expect(gitStatus(fresh, "bundle", "verify", bundle).status).not.toBe(0);
    git(fresh, "fetch", "-q", "--depth", "1", `file://${upstream}`, "main");
    expect(gitStatus(fresh, "bundle", "verify", bundle).status).toBe(0);
    git(fresh, "fetch", "-q", bundle, `${BUNDLE_HEAD_REF}:refs/heads/result`);
    expect(git(fresh, "rev-list", "--count", "refs/heads/result", "--not", base)).toBe("2");
  });

  it("leaves an excluded upstream tip out of the bundle: a merge's other parent is a prerequisite", async () => {
    const { upstream, work, base } = await shallowWorkRepo();
    git(upstream, "checkout", "-q", "-b", "feature");
    await commitFile(upstream, "u1.txt", "u1\n", "upstream one");
    const tip = await commitFile(upstream, "u2.txt", "u2\n", "upstream two");
    git(upstream, "checkout", "-q", "main");
    // As the control plane links a remote: its tip fetched into refs/remotes/<name>/<label>.
    git(work, "fetch", "-q", `file://${upstream}`, "feature:refs/remotes/up/feature");
    await commitFile(work, "b.txt", "b\n", "agent");
    git(work, "merge", "-q", "--no-edit", "refs/remotes/up/feature");
    const merge = git(work, "rev-parse", "HEAD");
    expect(git(work, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);

    expect(await createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [tip] })).toEqual({
      bundled: true,
      head: merge,
    });
    const bundle = join(work, ".git", RESULT_BUNDLE_NAME);
    expect((await bundlePrerequisites(bundle)).sort()).toEqual([base, tip].sort());
    // A repository with the base but not the tip can't take it: upstream's objects are not inside.
    const fresh = join(root, "fresh");
    await mkdir(fresh);
    git(fresh, "init", "-q");
    git(fresh, "fetch", "-q", "--depth", "1", `file://${upstream}`, "main");
    expect(gitStatus(fresh, "bundle", "verify", bundle).status).not.toBe(0);
    git(fresh, "fetch", "-q", `file://${upstream}`, "feature");
    expect(gitStatus(fresh, "bundle", "verify", bundle).status).toBe(0);
  });

  it("never reads the agent's .git/config or runs its hooks", async () => {
    const { work, base } = await shallowWorkRepo();
    const marker = join(root, `${randomUUID()}-pwned`);
    const hookMarker = join(root, `${randomUUID()}-hook`);
    const hooks = join(root, "hooks");
    await mkdir(hooks);
    for (const hook of ["post-checkout", "pre-commit", "reference-transaction", "pre-auto-gc"]) {
      await writeFile(join(hooks, hook), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o755 });
    }
    await commitFile(work, "b.txt", "b\n", "agent");
    const config = join(work, ".git", "config");
    await writeFile(
      config,
      `${await readFile(config, "utf8")}[core]\n\tfsmonitor = "touch '${marker}'"\n\thooksPath = ${hooks}\n` +
        `\tsshCommand = touch '${marker}'\n[gc]\n\tauto = 1\n[include]\n\tpath = ${join(root, "nope.inc")}\n`,
    );
    // The planted settings are live for git run in the agent's repository...
    const control = join(root, "control");
    git(root, "clone", "-q", "--no-local", work, control);
    await writeFile(join(control, ".git", "config"), await readFile(config, "utf8"));
    gitStatus(control, "status");
    gitStatus(control, "checkout", "-q", "-b", "probe");
    expect(await exists(marker)).toBe(true);
    expect(await exists(hookMarker)).toBe(true);
    await rm(marker);
    await rm(hookMarker);

    // ...and none of them runs when the bundle is made.
    const result = await createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [] });
    expect(result.bundled).toBe(true);
    expect(await exists(marker)).toBe(false);
    expect(await exists(hookMarker)).toBe(false);
  });

  it("ignores alternates planted in the agent's object store: objects only reachable there never enter the bundle", async () => {
    const { work, base } = await shallowWorkRepo();
    // Objects outside the workspace that the agent's store points at.
    const other = join(root, "other");
    await mkdir(other);
    git(other, "init", "-q");
    const secret = `outside-${randomUUID()}\n`;
    await commitFile(other, "secret.txt", secret, "outside");
    const secretBlob = git(other, "hash-object", "secret.txt");
    await writeFile(join(work, ".git", "objects", "info", "alternates"), `${join(other, ".git", "objects")}\n`);
    // With the alternate in place git finds the blob there and never writes it into the agent's store.
    await writeFile(join(work, "secret.txt"), secret);
    git(work, "add", "secret.txt");
    git(work, "commit", "-q", "-m", "agent");
    expect(await exists(join(work, ".git", "objects", secretBlob.slice(0, 2), secretBlob.slice(2)))).toBe(false);
    // Git run on the agent's repository itself would follow the alternate and bundle the blob.
    const direct = join(root, "direct.bundle");
    git(work, "bundle", "create", "-q", direct, "HEAD", "--not", base);

    await expect(createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [] })).rejects.toThrow(
      /^result_bundle_git_failed$/,
    );
    expect(await exists(join(work, ".git", RESULT_BUNDLE_NAME))).toBe(false);
  });

  it("returns no_new_commits and writes no bundle when HEAD is the base, removing a stale one", async () => {
    const { work, base } = await shallowWorkRepo();
    const bundle = join(work, ".git", RESULT_BUNDLE_NAME);
    await writeFile(bundle, "stale");
    expect(await createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [] })).toEqual({
      bundled: false,
      reason: "no_new_commits",
    });
    expect(await exists(bundle)).toBe(false);
  });

  it("returns no_new_commits when HEAD moved only onto an excluded remote tip", async () => {
    const { upstream, work, base } = await shallowWorkRepo();
    git(upstream, "checkout", "-q", "-b", "feature");
    const tip = await commitFile(upstream, "u.txt", "u\n", "upstream");
    git(work, "fetch", "-q", `file://${upstream}`, "feature:refs/remotes/up/feature");
    git(work, "reset", "-q", "--hard", "refs/remotes/up/feature");
    expect(await createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [tip] })).toEqual({
      bundled: false,
      reason: "no_new_commits",
    });
    expect(await exists(join(work, ".git", RESULT_BUNDLE_NAME))).toBe(false);
  });

  it("returns no_head for a symlinked HEAD, garbage HEAD, an unknown commit or a missing .git", async () => {
    const { work, base } = await shallowWorkRepo();
    await commitFile(work, "b.txt", "b\n", "agent");
    const headPath = join(work, ".git", "HEAD");
    const input = { repoPath: work, baseCommit: base, excludeCommits: [] };

    await writeFile(headPath, "garbage\n");
    expect(await createResultBundle(input)).toEqual({ bundled: false, reason: "no_head" });

    await writeFile(headPath, `${"0".repeat(40)}\n`);
    expect(await createResultBundle(input)).toEqual({ bundled: false, reason: "no_head" });

    const target = join(root, "HEAD-target");
    await writeFile(target, "ref: refs/heads/wardby/run-x\n");
    await rm(headPath);
    await symlink(target, headPath);
    expect(await createResultBundle(input)).toEqual({ bundled: false, reason: "no_head" });
    expect(await exists(join(work, ".git", RESULT_BUNDLE_NAME))).toBe(false);

    expect(await createResultBundle({ repoPath: join(root, "nothing"), baseCommit: base, excludeCommits: [] })).toEqual(
      { bundled: false, reason: "no_head" },
    );
  });

  it("never deletes or writes through a .git that is a symlink", async () => {
    const { work, base } = await shallowWorkRepo();
    await commitFile(work, "b.txt", "b\n", "agent");
    const victim = join(work, ".git", RESULT_BUNDLE_NAME);
    await writeFile(victim, "keep me");
    const linked = join(root, "linked");
    await mkdir(linked);
    await symlink(join(work, ".git"), join(linked, ".git"));
    expect(await createResultBundle({ repoPath: linked, baseCommit: base, excludeCommits: [] })).toEqual({
      bundled: false,
      reason: "no_head",
    });
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  it("replaces a planted bundle symlink without writing through it", async () => {
    const { work, base } = await shallowWorkRepo();
    const head = await commitFile(work, "b.txt", "b\n", "agent");
    const outside = join(root, "outside.txt");
    await writeFile(outside, "untouched");
    await symlink(outside, join(work, ".git", RESULT_BUNDLE_NAME));
    await writeFile(join(work, ".git", `${RESULT_BUNDLE_NAME}.lock`), "planted lock");
    expect(await createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [] })).toEqual({
      bundled: true,
      head,
    });
    expect(await readFile(outside, "utf8")).toBe("untouched");
    expect((await lstat(join(work, ".git", RESULT_BUNDLE_NAME))).isFile()).toBe(true);
  });

  it("refuses an invalid shallow file and leaves no bundle, not even one the agent planted", async () => {
    const { work, base } = await shallowWorkRepo();
    await commitFile(work, "b.txt", "b\n", "agent");
    await writeFile(join(work, ".git", RESULT_BUNDLE_NAME), "planted by the agent");
    await writeFile(join(work, ".git", "shallow"), `${base}\n--upload-pack=touch\n`);
    await expect(createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [] })).rejects.toThrow(
      /^result_bundle_shallow_invalid$/,
    );
    expect(await exists(join(work, ".git", RESULT_BUNDLE_NAME))).toBe(false);
  });

  it("refuses commits that are not 40-hex, never passing them to git, and leaves no bundle", async () => {
    const { work, base } = await shallowWorkRepo();
    await mkdir(join(work, ".git", RESULT_BUNDLE_NAME));
    await writeFile(join(work, ".git", RESULT_BUNDLE_NAME, "inside"), "planted");
    await expect(createResultBundle({ repoPath: work, baseCommit: "--all", excludeCommits: [] })).rejects.toThrow(
      /^result_bundle_input_invalid$/,
    );
    await expect(createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: ["HEAD"] })).rejects.toThrow(
      /^result_bundle_input_invalid$/,
    );
    expect(await exists(join(work, ".git", RESULT_BUNDLE_NAME))).toBe(false);
  });

  it("removes its scratch repository", async () => {
    const { work, base } = await shallowWorkRepo();
    await commitFile(work, "b.txt", "b\n", "agent");
    const scratchRoot = join(root, "scratch");
    await mkdir(scratchRoot);
    await createResultBundle({ repoPath: work, baseCommit: base, excludeCommits: [], scratchRoot });
    expect((await stat(scratchRoot)).isDirectory()).toBe(true);
    expect(await readdir(scratchRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------- gitAvailable and paths

describe("gitAvailable", () => {
  it("is true for a working git and false for a binary that does not exist", async () => {
    expect(await gitAvailable()).toBe(true);
    expect(await gitAvailable(join(root, "no-such-git"))).toBe(false);
  });
});

describe("resolveHistoryPath", () => {
  it("maps /workspace and /repos/<name> onto the given roots", () => {
    expect(resolveHistoryPath("/workspace", { workspace: "/w", reposRoot: "/r" })).toBe("/w");
    expect(resolveHistoryPath("/repos/api", { workspace: "/w", reposRoot: "/r" })).toBe("/r/api");
    expect(resolveHistoryPath("/repos/my.lib_2-x", {})).toBe("/repos/my.lib_2-x");
  });

  it("refuses anything else", () => {
    for (const path of [
      "/workspace/",
      "/repos/",
      "/repos/..",
      "/repos/.",
      "/repos/a/b",
      "/etc",
      "repos/a",
      "/repos/a\n",
    ]) {
      expect(resolveHistoryPath(path, {})).toBeNull();
    }
  });
});
