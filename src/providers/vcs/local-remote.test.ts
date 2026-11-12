import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalRemote } from "./local-remote.js";

const run = promisify(execFile);
let root = "";
let repo = "";

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return stdout.trim();
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "wardby-resolve-")));
  repo = join(root, "repo");
  await run("git", ["init", "--initial-branch=main", repo]);
  await writeFile(join(repo, "a.txt"), "a\n");
  await git("add", "a.txt");
  await git("commit", "-m", "c1");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalRemote.resolveCommit", () => {
  const remote = () => new LocalRemote({ roots: () => [root] });
  it("returns what git rev-parse names", async () => {
    await expect(remote().resolveCommit(`local:${repo}`, "main")).resolves.toBe(await git("rev-parse", "main"));
  });
  it("resolves a slashed branch name", async () => {
    await git("branch", "feature/x");
    await expect(remote().resolveCommit(`local:${repo}`, "feature/x")).resolves.toBe(
      await git("rev-parse", "feature/x"),
    );
  });
  it("returns null for a ref that does not exist", async () => {
    await expect(remote().resolveCommit(`local:${repo}`, "nope")).resolves.toBeNull();
  });
  it("refuses an unsafe ref name", async () => {
    await expect(remote().resolveCommit(`local:${repo}`, "a..b")).rejects.toThrow("invalid ref");
  });
});
