import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeGitCommandRunner } from "./git.js";
import { MAX_RESULT_COMMITS, importResultBundle, type ResultGit } from "./result-history.js";

const run = promisify(execFile);
/** A fake token-shaped value (never a real one). */
const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234";
const WARDBY = "Wardby <wardby@users.noreply.github.com>";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let home = "";
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
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
    GIT_AUTHOR_NAME: "Person",
    GIT_AUTHOR_EMAIL: "person@example.invalid",
    GIT_COMMITTER_NAME: "Person",
    GIT_COMMITTER_EMAIL: "person@example.invalid",
    ...extra,
  };
}

async function git(cwd: string, args: string[], extra: Record<string, string> = {}, input?: string): Promise<string> {
  const child = run("git", ["-c", "commit.gpgSign=false", ...args], { cwd, env: gitEnv(extra) });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  const { stdout } = await child;
  return stdout.trim();
}

async function commit(
  repo: string,
  files: Record<string, string>,
  message: string,
  extra: Record<string, string> = {},
): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(repo, file, ".."), { recursive: true });
    await writeFile(join(repo, file), content);
  }
  await git(repo, ["add", "--all"]);
  await git(repo, ["commit", "-q", "-m", message], extra);
  return git(repo, ["rev-parse", "HEAD"]);
}

interface Fixture {
  root: string;
  /** The control plane's git dir (bare): base, the upstream tip and everything before them. */
  control: string;
  /** The worker's clone, on a branch at base. */
  worker: string;
  /** main's first commit, where upstream forked. */
  forkPoint: string;
  base: string;
  /** upstream's tip and its parent (an older upstream commit). */
  tip: string;
  olderUpstream: string;
  bundle: string;
  runner: NodeGitCommandRunner;
  git: ResultGit;
}

/**
 * origin: main = forkPoint (a.txt, .github/workflows/ci.yml) -> base (a.txt changed);
 * upstream = forkPoint -> olderUpstream (up.txt) -> tip (up.txt, ci.yml and a.txt changed).
 */
async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wardby-result-history-")));
  cleanup.push(root);
  home = join(root, "home");
  await mkdir(home);
  const origin = join(root, "origin");
  await mkdir(origin);
  await git(origin, ["init", "-q", "--initial-branch=main"]);
  const forkPoint = await commit(origin, { "a.txt": "1\n", ".github/workflows/ci.yml": "ci\n" }, "fork point");
  const base = await commit(origin, { "a.txt": "2\n" }, "base");
  await git(origin, ["checkout", "-q", "-b", "upstream", forkPoint]);
  const olderUpstream = await commit(origin, { "up.txt": "u1\n" }, "upstream 1");
  const tip = await commit(
    origin,
    { "up.txt": "u2\n", "a.txt": "u\n", ".github/workflows/ci.yml": "ci upstream\n" },
    "upstream 2",
  );
  await git(origin, ["checkout", "-q", "main"]);
  const control = join(root, "control.git");
  await git(root, ["clone", "-q", "--bare", origin, control]);
  const worker = join(root, "worker");
  await git(root, ["clone", "-q", origin, worker]);
  await git(worker, ["checkout", "-q", "-b", "work", base]);
  const runner = new NodeGitCommandRunner({ homeDir: home });
  const bound: ResultGit = (args, options) =>
    runner.run([`--git-dir=${control}`, "-c", "protocol.allow=never", ...args], options);
  return {
    root,
    control,
    worker,
    forkPoint,
    base,
    tip,
    olderUpstream,
    bundle: join(root, "result.bundle"),
    runner,
    git: bound,
  };
}

/** What the worker driver does: one head, refs/wardby/bundle-head, everything not in base or the tips. */
async function makeBundle(f: Fixture, head = "HEAD"): Promise<void> {
  await git(f.worker, ["update-ref", "refs/wardby/bundle-head", head]);
  await git(f.worker, ["bundle", "create", "-q", f.bundle, "refs/wardby/bundle-head", "--not", f.base, f.tip]);
}

function importIt(f: Fixture, overrides: Partial<Parameters<typeof importResultBundle>[0]> = {}) {
  return importResultBundle({
    git: f.git,
    bundlePath: f.bundle,
    historyBase: f.base,
    remoteTips: [f.tip],
    runId: "r1",
    maxDiffBytes: 1024 * 1024,
    maxChangedFiles: 1_000,
    ...overrides,
  });
}

async function controlGit(f: Fixture, args: string[]): Promise<string> {
  return git(f.root, [`--git-dir=${f.control}`, ...args]);
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** Every message in an error's cause chain, and its own enumerable fields. */
function everythingIn(error: Error): string {
  const parts: string[] = [];
  let current: Error | undefined = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    parts.push(current.message, current.stack ?? "", JSON.stringify(current));
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n");
}

describe("importResultBundle (real git, #536)", { timeout: 60_000 }, () => {
  it("rewrites the agent's commits as Wardby, keeping trees, messages and author dates, with parents mapped", async () => {
    const f = await fixture();
    const first = await commit(f.worker, { "b.txt": "b\n" }, "add b\n\nbody", {
      GIT_AUTHOR_DATE: "@1700000000 +0130",
    });
    const second = await commit(f.worker, { "c.txt": "c\n" }, "add c", { GIT_AUTHOR_DATE: "@1700000100 -0700" });
    await makeBundle(f);
    const imported = await importIt(f);

    expect(imported.agentPaths.sort()).toEqual(["b.txt", "c.txt"]);
    expect(imported.mergePaths).toEqual([]);
    expect(imported.agentDiffBytes).toBeGreaterThan(0);
    expect(await controlGit(f, ["rev-parse", "refs/wardby/result-rewritten"])).toBe(imported.tip);
    expect(await controlGit(f, ["rev-parse", "refs/wardby/result-raw"])).toBe(second);
    const chain = (await controlGit(f, ["rev-list", "--parents", imported.tip, "--not", f.base])).split("\n");
    expect(chain).toHaveLength(2);
    expect(chain.join("\n")).not.toContain(first);
    expect(chain.join("\n")).not.toContain(second);
    const [tipLine, firstLine] = chain.map((line) => line.split(" "));
    expect(tipLine[1]).toBe(firstLine[0]);
    expect(firstLine[1]).toBe(f.base);
    const show = (rev: string, format: string) => controlGit(f, ["show", "-s", `--format=${format}`, rev]);
    for (const [rewritten, original] of [
      [firstLine[0], first],
      [tipLine[0], second],
    ]) {
      expect(await show(rewritten, "%an <%ae>|%cn <%ce>")).toBe(`${WARDBY}|${WARDBY}`);
      expect(await show(rewritten, "%T|%B|%at %ai")).toBe(await show(original, "%T|%B|%at %ai"));
      expect(await show(rewritten, "%G?")).toBe("N");
    }
  });

  it("keeps an upstream tip as a merge's parent, and counts only the paths the merge resolved as the agent's", async () => {
    const f = await fixture();
    // up.txt and ci.yml come from upstream unchanged; a.txt conflicts and is resolved by the agent.
    await git(f.worker, ["merge", "-q", "--no-edit", f.tip]).catch(() => undefined);
    await writeFile(join(f.worker, "a.txt"), "resolved\n");
    await git(f.worker, ["add", "--all"]);
    await git(f.worker, ["commit", "-q", "--no-edit"]);
    await makeBundle(f);
    const imported = await importIt(f);

    expect(imported.agentPaths).toEqual(["a.txt"]);
    expect(imported.mergePaths).toEqual(["a.txt"]);
    const parents = (await controlGit(f, ["rev-list", "--parents", "-n", "1", imported.tip])).split(" ");
    expect(parents.slice(1)).toEqual([f.base, f.tip]);
    expect(await controlGit(f, ["show", "-s", "--format=%an <%ae>", imported.tip])).toBe(WARDBY);
  });

  it("refuses a bundle with two heads", async () => {
    const f = await fixture();
    await commit(f.worker, { "b.txt": "b\n" }, "b");
    await git(f.worker, ["update-ref", "refs/wardby/bundle-head", "HEAD"]);
    await git(f.worker, ["update-ref", "refs/wardby/other", "HEAD"]);
    await git(f.worker, [
      "bundle",
      "create",
      "-q",
      f.bundle,
      "refs/wardby/bundle-head",
      "refs/wardby/other",
      "--not",
      f.base,
    ]);
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_bundle_invalid");
  });

  it("refuses a corrupt bundle, a truncated one, a missing one and a symlink, never with git's output", async () => {
    const f = await fixture();
    await writeFile(f.bundle, `garbage ${FAKE_TOKEN}\n`);
    const error = await errorOf(importIt(f));
    expect(error.message).toBe("vcs_result_bundle_invalid");
    expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
    expect(everythingIn(error)).not.toContain("garbage");

    await commit(f.worker, { "b.txt": "b\n".repeat(1000) }, "b");
    await makeBundle(f);
    const bytes = await readFile(f.bundle);
    await writeFile(f.bundle, bytes.subarray(0, bytes.length - 40));
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_bundle_invalid");

    await rm(f.bundle);
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_bundle_invalid");
    await writeFile(join(f.root, "real.bundle"), bytes);
    await symlink(join(f.root, "real.bundle"), f.bundle);
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_bundle_invalid");
  });

  it("refuses a head that does not descend from the history base", async () => {
    const f = await fixture();
    await git(f.worker, ["checkout", "-q", "-b", "side", f.forkPoint]);
    await commit(f.worker, { "b.txt": "b\n" }, "not on base");
    await makeBundle(f);
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_history_invalid");
  });

  it("refuses a merge whose parent is an older upstream commit, not the fetched tip", async () => {
    const f = await fixture();
    await git(f.worker, ["merge", "-q", "--no-edit", f.olderUpstream]);
    await makeBundle(f);
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_history_invalid");
  });

  it("refuses a merge that brings in an unrelated root commit", async () => {
    const f = await fixture();
    await git(f.worker, ["checkout", "-q", "--orphan", "orphan"]);
    await git(f.worker, ["rm", "-rfq", "."]);
    const orphan = await commit(f.worker, { "o.txt": "o\n" }, "orphan");
    await git(f.worker, ["checkout", "-q", "work"]);
    await git(f.worker, ["merge", "-q", "--no-edit", "--allow-unrelated-histories", orphan]);
    await makeBundle(f);
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_history_invalid");
  });

  it(`refuses more than ${MAX_RESULT_COMMITS} new commits`, async () => {
    const f = await fixture();
    const stream: string[] = [];
    for (let n = 1; n <= MAX_RESULT_COMMITS + 1; n += 1) {
      const message = `commit ${n}\n`;
      const content = `${n}\n`;
      stream.push(
        "commit refs/heads/work",
        `committer Person <person@example.invalid> ${1700000000 + n} +0000`,
        `data ${Buffer.byteLength(message)}`,
        message,
        ...(n === 1 ? [`from ${f.base}`] : []),
        "M 100644 inline n.txt",
        `data ${Buffer.byteLength(content)}`,
        content,
      );
    }
    await git(f.worker, ["fast-import", "--quiet", "--force"], {}, `${stream.join("\n")}\n`);
    await makeBundle(f, "refs/heads/work");
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_commit_limit");
  });

  it("refuses a commit message holding a token-shaped value, never echoing it", async () => {
    const f = await fixture();
    await commit(f.worker, { "b.txt": "b\n" }, `oops ${FAKE_TOKEN}`);
    await makeBundle(f);
    const error = await errorOf(importIt(f));
    expect(error.message).toBe("vcs_result_commit_unsafe");
    expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
    await expect(controlGit(f, ["rev-parse", "--verify", "-q", "refs/wardby/result-rewritten"])).rejects.toThrow();
  });

  it("refuses an author or committer identity holding a token-shaped value", async () => {
    const identities: Record<string, string>[] = [
      { GIT_AUTHOR_EMAIL: `${FAKE_TOKEN}@example.invalid` },
      { GIT_COMMITTER_NAME: `x ${FAKE_TOKEN}` },
    ];
    for (const extra of identities) {
      const f = await fixture();
      await commit(f.worker, { "b.txt": "b\n" }, "fine", extra);
      await makeBundle(f);
      const error = await errorOf(importIt(f));
      expect(error.message).toBe("vcs_result_commit_unsafe");
      expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
    }
  });

  it("refuses a commit message over 64 KiB", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "message"), "x".repeat(64 * 1024 + 1));
    await writeFile(join(f.worker, "b.txt"), "b\n");
    await git(f.worker, ["add", "--all"]);
    await git(f.worker, ["commit", "-q", "-F", join(f.root, "message")]);
    await makeBundle(f);
    expect((await errorOf(importIt(f))).message).toBe("vcs_result_commit_unsafe");
  });

  it("refuses a submodule, a symlink out of the repository and a .git path in an agent commit", async () => {
    const gitlink = await fixture();
    await git(gitlink.worker, ["update-index", "--add", "--cacheinfo", `160000,${gitlink.base},vendor/sub`]);
    await git(gitlink.worker, ["commit", "-q", "-m", "submodule"]);
    await makeBundle(gitlink);
    expect((await errorOf(importIt(gitlink))).message).toBe("vcs_nested_repository");

    const escape = await fixture();
    await symlink("/etc/passwd", join(escape.worker, "link"));
    await git(escape.worker, ["add", "--all"]);
    await git(escape.worker, ["commit", "-q", "-m", "link"]);
    await makeBundle(escape);
    expect((await errorOf(importIt(escape))).message).toBe("vcs_symlink_escape");

    const dotgit = await fixture();
    const blob = await git(dotgit.worker, ["hash-object", "-w", "--stdin"], {}, "[core]\n\tfsmonitor = evil\n");
    const inner = await git(dotgit.worker, ["mktree"], {}, `100644 blob ${blob}\tconfig\n`);
    const dotGitDir = await git(dotgit.worker, ["mktree"], {}, `040000 tree ${inner}\t.GIT\n`);
    const listing = await git(dotgit.worker, ["ls-tree", dotgit.base]);
    const rootTree = await git(dotgit.worker, ["mktree"], {}, `${listing}\n040000 tree ${dotGitDir}\tvendor\n`);
    const planted = await git(dotgit.worker, ["commit-tree", rootTree, "-p", dotgit.base, "-m", "planted"]);
    await makeBundle(dotgit, planted);
    const error = await errorOf(importIt(dotgit));
    // fsck may refuse it first; either way nothing is imported.
    expect(["vcs_nested_repository", "vcs_result_bundle_invalid"]).toContain(error.message);
  });

  it("refuses agent diffs over the diff limit", async () => {
    const f = await fixture();
    await commit(f.worker, { "big.txt": "x".repeat(4096) }, "big");
    await makeBundle(f);
    expect((await errorOf(importIt(f, { maxDiffBytes: 1024 }))).message).toBe("vcs_diff_size_limit");
  });

  it("bounds its git calls by a timeout", async () => {
    const f = await fixture();
    await commit(f.worker, { "b.txt": "b\n" }, "b");
    await makeBundle(f);
    const seen: (number | undefined)[] = [];
    const watching: ResultGit = (args, options) => {
      seen.push(options?.timeoutMs);
      return f.git(args, options);
    };
    await importIt(f, { git: watching });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((timeout) => typeof timeout === "number" && timeout > 0)).toBe(true);
  });
});
