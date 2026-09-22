import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false"];

async function git(cwd: string, args: string[], gitDir?: string): Promise<string> {
  const prefix = gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${cwd}`] : [];
  const { stdout } = await run("git", [...IDENTITY, ...prefix, ...args], { cwd });
  return stdout.trim();
}

describe("depth-1 clone supports Wardby's finalize path (real git)", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("commits on baseCommit and pushes a new branch whose parent is baseCommit", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-shallow-"));
    roots.push(root);
    const seed = join(root, "seed");
    const remote = join(root, "remote.git");
    const workspace = join(root, "workspace");
    const meta = join(root, "meta");

    // A remote with three commits on main, so depth 1 genuinely truncates history.
    await run("git", ["init", "--initial-branch=main", seed]);
    for (const n of [1, 2, 3]) {
      await writeFile(join(seed, "file.txt"), `v${n}\n`);
      await git(seed, ["add", "file.txt"]);
      await git(seed, ["commit", "-m", `c${n}`]);
    }
    await run("git", ["clone", "--bare", seed, remote]);
    const baseCommit = await git(seed, ["rev-parse", "HEAD"]);

    // Mirror prepareWorkspace's clone shape.
    await run("git", [
      "clone",
      "--no-checkout",
      "--single-branch",
      "--no-tags",
      "--depth",
      "1",
      "--branch",
      "main",
      "--separate-git-dir",
      meta,
      `file://${remote}`,
      workspace,
    ]);
    await rm(join(workspace, ".git"), { force: true });
    expect(await git(workspace, ["rev-parse", "--is-shallow-repository"], meta)).toBe("true");
    expect(await git(workspace, ["rev-list", "--count", "HEAD"], meta)).toBe("1");

    await git(workspace, ["read-tree", "--reset", "-u", baseCommit], meta);
    await writeFile(join(workspace, "file.txt"), "changed\n");
    await git(workspace, ["add", "--all"], meta);
    await git(workspace, ["commit", "--no-verify", "-m", "Wardby run test"], meta);
    const commitSha = await git(workspace, ["rev-parse", "HEAD"], meta);
    expect(await git(workspace, ["rev-parse", "HEAD^"], meta)).toBe(baseCommit);

    await git(workspace, ["push", "origin", `${commitSha}:refs/heads/wardby/run-test`], meta);
    expect(await git(remote, ["rev-parse", "refs/heads/wardby/run-test"])).toBe(commitSha);
    expect(await git(remote, ["rev-parse", `${commitSha}^`])).toBe(baseCommit);
  });
});
