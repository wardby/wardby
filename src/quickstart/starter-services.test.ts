import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseServiceDeclaration } from "../coding/services/declaration.js";
import {
  STARTER_SERVICES_BRANCH,
  commitStarterServices,
  declaredServicesLabel,
  inspectDeclaredServices,
  parseStarterChoice,
  repoDefaultBranch,
  starterServicesYaml,
} from "./starter-services.js";

let dir: string;
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "pipe",
    encoding: "utf8",
  });

/** Every file under the work tree except .git, with its bytes, so a before/after comparison is exact. */
function workTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (relative(root, full) === ".git") continue;
      if (entry.isDirectory()) walk(full);
      else files[relative(root, full)] = readFileSync(full).toString("base64");
    }
  };
  walk(root);
  return files;
}

/** Working tree, index file bytes, staged diff, status, HEAD symref and current branch. */
function snapshot() {
  return {
    tree: workTree(dir),
    index: readFileSync(join(dir, ".git", "index")).toString("base64"),
    cached: git("--no-optional-locks", "diff", "--cached"),
    status: git("--no-optional-locks", "status", "--porcelain"),
    headFile: readFileSync(join(dir, ".git", "HEAD"), "utf8"),
    symref: git("symbolic-ref", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    head: git("rev-parse", "HEAD"),
  };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "starter-services-")));
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "b.txt"), "b\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  // A dirty tree: one staged change, one unstaged change, one untracked file.
  writeFileSync(join(dir, "a.txt"), "staged\n");
  git("add", "a.txt");
  writeFileSync(join(dir, "src", "b.txt"), "unstaged\n");
  writeFileSync(join(dir, "untracked.txt"), "u\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("starterServicesYaml", () => {
  it.each([
    [["postgres"], [{ name: "postgres", version: "16" }]],
    [["redis"], [{ name: "redis", version: "7" }]],
    [
      ["postgres", "redis"],
      [
        { name: "postgres", version: "16" },
        { name: "redis", version: "7" },
      ],
    ],
  ] as const)("is accepted by parseServiceDeclaration for %j", (choices, expected) => {
    expect(parseServiceDeclaration(starterServicesYaml([...choices]))).toEqual({ services: expected });
  });

  it("parses the --starter-services flag", () => {
    expect(parseStarterChoice("none")).toEqual([]);
    expect(parseStarterChoice("postgres,redis")).toEqual(["postgres", "redis"]);
    expect(parseStarterChoice("redis, postgres,redis")).toEqual(["postgres", "redis"]);
    expect(() => parseStarterChoice("mysql")).toThrow(/postgres, redis, or none/);
  });
});

describe("repoDefaultBranch", () => {
  it("is the checked-out branch and its commit", async () => {
    expect(await repoDefaultBranch(dir)).toEqual({ branch: "main", sha: git("rev-parse", "HEAD").trim() });
  });

  it("is null for a repository with no commits", async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "starter-empty-")));
    try {
      execFileSync("git", ["-C", empty, "init", "-q", "-b", "main"]);
      expect(await repoDefaultBranch(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("commitStarterServices", () => {
  it("commits the file onto a new branch without touching the work tree, index, or HEAD", async () => {
    const base = (await repoDefaultBranch(dir))!;
    const before = snapshot();
    const content = starterServicesYaml(["postgres", "redis"]);

    const result = await commitStarterServices({ dir, baseSha: base.sha, content, confirmReplace: async () => false });

    expect(result.status).toBe("created");
    expect(snapshot()).toEqual(before);
    expect(git("show", `${STARTER_SERVICES_BRANCH}:.wardby/services.yaml`)).toBe(content);
    expect(git("rev-parse", `${STARTER_SERVICES_BRANCH}^`).trim()).toBe(base.sha);
    // Only the one file was added on top of the base tree.
    expect(git("diff", "--name-status", base.sha, STARTER_SERVICES_BRANCH).trim()).toBe("A\t.wardby/services.yaml");
    expect(git("log", "-1", "--format=%an <%ae>|%s", STARTER_SERVICES_BRANCH).trim()).toBe(
      "wardby quickstart <quickstart@wardby.invalid>|Add starter .wardby/services.yaml (wardby quickstart)",
    );
  });

  it("works without any git identity configured", async () => {
    const base = (await repoDefaultBranch(dir))!;
    const home = realpathSync(mkdtempSync(join(tmpdir(), "starter-home-")));
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    try {
      const result = await commitStarterServices({
        dir,
        baseSha: base.sha,
        content: starterServicesYaml(["redis"]),
        confirmReplace: async () => false,
      });
      expect(result.status).toBe("created");
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores a GIT_INDEX_FILE / GIT_DIR in the caller's environment", async () => {
    const base = (await repoDefaultBranch(dir))!;
    const before = snapshot();
    const saved = { GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_DIR: process.env.GIT_DIR };
    process.env.GIT_INDEX_FILE = join(dir, ".git", "index");
    process.env.GIT_DIR = "/nonexistent";
    try {
      const result = await commitStarterServices({
        dir,
        baseSha: base.sha,
        content: starterServicesYaml(["postgres"]),
        confirmReplace: async () => false,
      });
      expect(result.status).toBe("created");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(snapshot()).toEqual(before);
  });

  it("keeps an existing branch when the replacement is declined", async () => {
    const base = (await repoDefaultBranch(dir))!;
    git("branch", STARTER_SERVICES_BRANCH, base.sha);
    let asked: string | undefined;
    const result = await commitStarterServices({
      dir,
      baseSha: base.sha,
      content: starterServicesYaml(["postgres"]),
      confirmReplace: async (existing) => {
        asked = existing;
        return false;
      },
    });
    expect(result.status).toBe("kept");
    expect(asked).toBe(base.sha);
    expect(git("rev-parse", STARTER_SERVICES_BRANCH).trim()).toBe(base.sha);
  });

  it("replaces an existing branch when confirmed", async () => {
    const base = (await repoDefaultBranch(dir))!;
    git("branch", STARTER_SERVICES_BRANCH, base.sha);
    const before = snapshot();
    const content = starterServicesYaml(["redis"]);
    const result = await commitStarterServices({ dir, baseSha: base.sha, content, confirmReplace: async () => true });
    expect(result.status).toBe("replaced");
    expect(git("show", `${STARTER_SERVICES_BRANCH}:.wardby/services.yaml`)).toBe(content);
    expect(snapshot()).toEqual(before);
  });

  it("does not overwrite a branch that moved after it was read (compare-and-swap)", async () => {
    const base = (await repoDefaultBranch(dir))!;
    git("branch", STARTER_SERVICES_BRANCH, base.sha);
    const result = await commitStarterServices({
      dir,
      baseSha: base.sha,
      content: starterServicesYaml(["redis"]),
      confirmReplace: async () => {
        // Someone else moves the branch while we are asking.
        const other = git("commit-tree", "-p", base.sha, "-m", "other", `${base.sha}^{tree}`).trim();
        git("update-ref", `refs/heads/${STARTER_SERVICES_BRANCH}`, other);
        return true;
      },
    });
    expect(result.status).toBe("refused");
    expect(git("log", "-1", "--format=%s", STARTER_SERVICES_BRANCH).trim()).toBe("other");
  });

  it("refuses, without creating the branch, when the base tree has a file named .wardby", async () => {
    git("stash", "-q", "--include-untracked");
    writeFileSync(join(dir, ".wardby"), "not a folder\n");
    git("add", ".wardby");
    git("commit", "-q", "-m", "file");
    const base = (await repoDefaultBranch(dir))!;
    const result = await commitStarterServices({
      dir,
      baseSha: base.sha,
      content: starterServicesYaml(["redis"]),
      confirmReplace: async () => true,
    });
    expect(result.status).toBe("refused");
    expect(git("branch", "--list", STARTER_SERVICES_BRANCH).trim()).toBe("");
  });

  it("refuses when the branch is checked out", async () => {
    const base = (await repoDefaultBranch(dir))!;
    git("stash", "-q", "--include-untracked");
    git("checkout", "-q", "-b", STARTER_SERVICES_BRANCH);
    const result = await commitStarterServices({
      dir,
      baseSha: base.sha,
      content: starterServicesYaml(["redis"]),
      confirmReplace: async () => true,
    });
    expect(result.status).toBe("refused");
    expect(git("rev-parse", "HEAD").trim()).toBe(base.sha);
  });

  it("refuses when the branch is checked out in another worktree", async () => {
    const base = (await repoDefaultBranch(dir))!;
    const other = realpathSync(mkdtempSync(join(tmpdir(), "starter-wt-")));
    try {
      git("worktree", "add", "-q", "-b", STARTER_SERVICES_BRANCH, join(other, "wt"), base.sha);
      const result = await commitStarterServices({
        dir,
        baseSha: base.sha,
        content: starterServicesYaml(["redis"]),
        confirmReplace: async () => true,
      });
      expect(result.status).toBe("refused");
      expect(git("rev-parse", STARTER_SERVICES_BRANCH).trim()).toBe(base.sha);
    } finally {
      rmSync(other, { recursive: true, force: true });
      git("worktree", "prune");
    }
  });
});

describe("inspectDeclaredServices", () => {
  it("is absent when the default branch has no file", async () => {
    expect(await inspectDeclaredServices(dir, [dir], "main")).toEqual({ kind: "absent" });
  });

  it("reads only the committed file on the branch", async () => {
    git("stash", "-q", "--include-untracked");
    mkdirSync(join(dir, ".wardby"));
    writeFileSync(join(dir, ".wardby", "services.yaml"), 'services:\n  postgres: "16"\n');
    git("add", ".wardby/services.yaml");
    git("commit", "-q", "-m", "services");
    writeFileSync(join(dir, ".wardby", "services.yaml"), "garbage\n"); // uncommitted: ignored
    expect(await inspectDeclaredServices(dir, [dir], "main")).toEqual({
      kind: "valid",
      services: [{ name: "postgres", version: "16" }],
    });
  });

  it("lists a toolchain first and labels it", async () => {
    git("stash", "-q", "--include-untracked");
    mkdirSync(join(dir, ".wardby"));
    writeFileSync(
      join(dir, ".wardby", "services.yaml"),
      'services:\n  postgres: "16"\ntoolchain:\n  python-dev: "3.13"\n',
    );
    git("add", ".wardby/services.yaml");
    git("commit", "-q", "-m", "services");
    const result = await inspectDeclaredServices(dir, [dir], "main");
    expect(result).toEqual({
      kind: "valid",
      services: [
        { name: "python-dev", version: "3.13" },
        { name: "postgres", version: "16" },
      ],
      toolchain: { name: "python-dev", version: "3.13" },
    });
    expect(result.kind === "valid" && declaredServicesLabel(result)).toBe("python-dev 3.13 (toolchain), postgres 16");
  });

  it("reports an invalid file with its reason", async () => {
    git("stash", "-q", "--include-untracked");
    mkdirSync(join(dir, ".wardby"));
    writeFileSync(join(dir, ".wardby", "services.yaml"), "other: 1\n");
    git("add", ".wardby/services.yaml");
    git("commit", "-q", "-m", "services");
    const result = await inspectDeclaredServices(dir, [dir], "main");
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toMatch(/only top-level key/);
  });
});
