import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { collectExclusions, gitExcludePathspecs } from "../../coding/collect-exclude.js";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false"];

describe("collection exclusions at staging (real git)", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("keeps a tracked file under an excluded folder and ignores an untracked one", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-collect-exclude-"));
    roots.push(root);
    const work = join(root, "work");
    await run("git", ["init", "--initial-branch=main", work]);
    await mkdir(join(work, "vendor", "node_modules"), { recursive: true });
    await writeFile(join(work, "vendor", "node_modules", "tracked.js"), "tracked\n");
    await writeFile(join(work, "app.ts"), "v1\n");
    await run("git", [...IDENTITY, "add", "."], { cwd: work });
    await run("git", [...IDENTITY, "commit", "-m", "base"], { cwd: work });

    // What collection hands back: excluded folders are absent, a new install folder is present.
    await rm(join(work, "vendor", "node_modules"), { recursive: true });
    await mkdir(join(work, "web", "node_modules", "react"), { recursive: true });
    await writeFile(join(work, "web", "node_modules", "react", "index.js"), "installed\n");
    await writeFile(join(work, "app.ts"), "v2\n");

    const specs = gitExcludePathspecs(collectExclusions([]));
    await run("git", [...IDENTITY, "add", "--all", "--", ":/", ...specs], { cwd: work });
    const { stdout } = await run("git", ["diff", "--cached", "--name-status", "--no-renames", "HEAD"], {
      cwd: work,
    });
    expect(stdout.trim()).toBe("M\tapp.ts");
  });
});
