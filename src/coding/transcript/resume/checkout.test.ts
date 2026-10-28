import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubRemoteRepository, prepareCheckout, realGit, type Git } from "./checkout.js";
import { git, makeRepo, meta } from "./resume.test-support.js";

describe("githubRemoteRepository", () => {
  it("reads owner/name from https, ssh and scp remotes", () => {
    for (const url of [
      "https://github.com/Your-Org/your-repo.git",
      "https://github.com/your-org/your-repo",
      "git@github.com:your-org/your-repo.git",
      "ssh://git@github.com/your-org/your-repo.git",
    ]) {
      expect(githubRemoteRepository(url)).toBe("your-org/your-repo");
    }
    expect(githubRemoteRepository("https://gitlab.com/your-org/your-repo.git")).toBeUndefined();
    expect(githubRemoteRepository("/srv/git/your-repo.git")).toBeUndefined();
  });
});

describe("prepareCheckout: local repositories", () => {
  it("checks the run branch out detached, even while it is checked out in another worktree", async () => {
    const { dir, head } = makeRepo();
    // The run's branch is in use elsewhere: a plain `worktree add <dir> <branch>` would fail.
    git(dir, "worktree", "add", "-q", join(dir, "..", "busy"), "wardby/run-x");
    const result = await prepareCheckout(
      meta({ repository: `local:${dir}`, headRef: "main", resultBranch: "wardby/run-x" }),
      {
        cwd: tmpdir(),
      },
    );
    expect(result.outcome).toBe("created");
    expect(result.dir).toBe(join(dir, "..", `app-run-${meta().runId.slice(-8)}`));
    expect(result.ref).toBe("wardby/run-x");
    expect(git(result.dir, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(result.dir, "README.md"), "utf8")).toBe("run change\n");
    expect(result.warnings).toEqual([]);
    // A second import reuses the worktree.
    const again = await prepareCheckout(
      meta({ repository: `local:${dir}`, headRef: "main", resultBranch: "wardby/run-x" }),
      { cwd: tmpdir() },
    );
    expect(again.outcome).toBe("reused");
  });

  it("falls back to the base commit with a warning when the branch is gone", async () => {
    const { dir, base } = makeRepo();
    const target = join(dir, "..", "custom");
    const result = await prepareCheckout(
      meta({ repository: `local:${dir}`, headRef: "main", resultBranch: "wardby/never-pushed", baseSha: base }),
      { cwd: tmpdir(), dir: target },
    );
    expect(result.dir).toBe(target);
    expect(result.ref).toBe(base);
    expect(git(target, "rev-parse", "HEAD")).toBe(base);
    expect(result.warnings[0]).toMatch(/not in this checkout/);
  });

  it("refuses an existing directory that is not this repository's worktree", async () => {
    const { dir } = makeRepo();
    const other = mkdtempSync(join(tmpdir(), "other-"));
    await expect(
      prepareCheckout(meta({ repository: `local:${dir}`, resultBranch: "wardby/run-x" }), {
        cwd: tmpdir(),
        dir: other,
      }),
    ).rejects.toThrow(/already exists and is not a checkout of this repository/);
  });

  it("--here uses the current directory and checks nothing out", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "here-"));
    const result = await prepareCheckout(meta(), { cwd, here: true });
    expect(result).toMatchObject({ dir: cwd, outcome: "here" });
  });
});

describe("prepareCheckout: hosted repositories", () => {
  /** A clone whose `origin` reports a GitHub URL but fetches from a local bare repository. */
  function hostedClone(remoteUrl = "git@github.com:your-org/your-repo.git") {
    const { dir: upstream, head, base } = makeRepo();
    const bare = join(upstream, "..", "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", upstream, bare]);
    const clone = join(upstream, "..", "clone");
    execFileSync("git", ["clone", "-q", bare, clone]);
    const fakeGit: Git = (args, cwd) =>
      args[0] === "remote" && args[1] === "get-url" ? Promise.resolve(remoteUrl) : realGit(args, cwd);
    return { clone, head, base, fakeGit };
  }

  it("fetches the run branch from the matching remote and checks it out detached", async () => {
    const { clone, head, fakeGit } = hostedClone();
    const result = await prepareCheckout(meta({ headRef: "wardby/run-x" }), { cwd: clone, git: fakeGit });
    expect(result.dir).toBe(join(realpathSync(clone), "..", `clone-run-${meta().runId.slice(-8)}`));
    expect(git(result.dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("stops outside a clone of the repository and names the clone URL", async () => {
    const { clone, fakeGit } = hostedClone("https://github.com/someone/else.git");
    await expect(prepareCheckout(meta(), { cwd: clone, git: fakeGit })).rejects.toThrow(
      /not a clone of your-org\/your-repo.*git clone https:\/\/github\.com\/your-org\/your-repo\.git/,
    );
    const notGit = mkdtempSync(join(tmpdir(), "not-git-"));
    await expect(prepareCheckout(meta(), { cwd: notGit })).rejects.toThrow(/inside a clone of your-org\/your-repo/);
  });

  it("falls back to the base commit when the branch was never pushed", async () => {
    const { clone, base, fakeGit } = hostedClone();
    const result = await prepareCheckout(meta({ headRef: "wardby/missing", baseSha: base }), {
      cwd: clone,
      git: fakeGit,
    });
    expect(git(result.dir, "rev-parse", "HEAD")).toBe(base);
    expect(result.warnings[0]).toMatch(/could not be fetched/);
    expect(existsSync(result.dir)).toBe(true);
  });
});
