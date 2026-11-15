import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceDirectoryFromStaging, takeResultBundle } from "./workspace-swap.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function destination() {
  const root = await mkdtemp(join(tmpdir(), "wardby-swap-"));
  roots.push(root);
  const target = join(root, "workspace");
  await mkdir(target);
  await writeFile(join(target, "original.txt"), "original");
  return { root, target };
}

const siblings = async (root: string) => (await readdir(root)).filter((name) => name !== "workspace");

describe("replaceDirectoryFromStaging", () => {
  it("swaps a validated staging directory into place", async () => {
    const { root, target } = await destination();
    await replaceDirectoryFromStaging(target, 1024, "swap_destination_invalid", async (staging) => {
      await writeFile(join(staging, "new.txt"), "new");
    });
    expect(await readdir(target)).toEqual(["new.txt"]);
    expect(await siblings(root)).toEqual([]);
  });

  it("removes a rejected staging tree without validating or swapping it", async () => {
    const { root, target } = await destination();
    let staged = "";
    await expect(
      replaceDirectoryFromStaging(target, 1024, "swap_destination_invalid", async (staging) => {
        staged = staging;
        await symlink("/etc", join(staging, "escape"));
        await writeFile(join(staging, "partial.txt"), "partial");
        throw new Error("extract_symlink_escape");
      }),
    ).rejects.toThrow("extract_symlink_escape");
    expect(staged).not.toBe("");
    expect(await siblings(root)).toEqual([]);
    expect(await readFile(join(target, "original.txt"), "utf8")).toBe("original");
    expect(await readdir(target)).toEqual(["original.txt"]);
    // The symlink target outside the tree is untouched (rm never follows it).
    expect((await readdir("/etc")).length).toBeGreaterThan(0);
  });

  it("keeps the destination when the filled tree fails validation", async () => {
    const { root, target } = await destination();
    await expect(
      replaceDirectoryFromStaging(target, 1024, "swap_destination_invalid", async (staging) => {
        await symlink("/etc", join(staging, "escape"));
      }),
    ).rejects.toThrow("docker_workspace_symlink_escape");
    expect(await siblings(root)).toEqual([]);
    expect(await readdir(target)).toEqual(["original.txt"]);
  });

  it("rejects a destination that is a symlink with the caller's error code", async () => {
    const { root, target } = await destination();
    const link = join(root, "linked");
    await symlink(target, link);
    await expect(replaceDirectoryFromStaging(link, 1024, "swap_destination_invalid", async () => {})).rejects.toThrow(
      "swap_destination_invalid",
    );
  });
});

describe("takeResultBundle (history runs)", () => {
  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), "wardby-bundle-"));
    roots.push(root);
    const tree = join(root, "staging");
    await mkdir(join(tree, ".git", "objects"), { recursive: true });
    await writeFile(join(tree, "README.md"), "hello");
    await writeFile(join(tree, ".git", "HEAD"), "ref: refs/heads/main\n");
    return { root, tree, bundleDestination: join(root, "trusted", "result.bundle") };
  }

  it("moves a regular bundle to the trusted path and drops the root .git", async () => {
    const { root, tree, bundleDestination } = await workspace();
    await mkdir(join(root, "trusted"));
    const bytes = Buffer.from([0x23, 0x20, 0x76, 0x32, 0x00, 0xff, 0x80, 0x0a]);
    await writeFile(join(tree, ".git", "wardby-result.bundle"), bytes);
    expect(await takeResultBundle(tree, { bundleDestination, maxBundleBytes: 1024 })).toBe(true);
    expect(await readFile(bundleDestination)).toEqual(bytes);
    expect(await readdir(tree)).toEqual(["README.md"]);
  });

  it("reports no bundle, and still drops .git, when the worker wrote none", async () => {
    const { root, tree, bundleDestination } = await workspace();
    expect(await takeResultBundle(tree, { bundleDestination, maxBundleBytes: 1024 })).toBe(false);
    expect(await readdir(tree)).toEqual(["README.md"]);
    expect(await readdir(root)).toEqual(["staging"]);
  });

  it("ignores a symlinked bundle without following it", async () => {
    const { root, tree, bundleDestination } = await workspace();
    await mkdir(join(root, "trusted"));
    const secret = join(root, "secret.txt");
    await writeFile(secret, "fake-secret-value");
    await symlink(secret, join(tree, ".git", "wardby-result.bundle"));
    expect(await takeResultBundle(tree, { bundleDestination, maxBundleBytes: 1024 })).toBe(false);
    await expect(lstat(bundleDestination)).rejects.toThrow(/ENOENT/);
    expect(await readFile(secret, "utf8")).toBe("fake-secret-value");
    expect(await readdir(tree)).toEqual(["README.md"]);
  });

  it("ignores a bundle that is not a regular file (a folder, a FIFO)", async () => {
    const { root, tree, bundleDestination } = await workspace();
    await mkdir(join(root, "trusted"));
    await mkdir(join(tree, ".git", "wardby-result.bundle"));
    expect(await takeResultBundle(tree, { bundleDestination, maxBundleBytes: 1024 })).toBe(false);
    await mkdir(join(tree, ".git"));
    execFileSync("mkfifo", [join(tree, ".git", "wardby-result.bundle")]);
    expect(await takeResultBundle(tree, { bundleDestination, maxBundleBytes: 1024 })).toBe(false);
    await expect(lstat(bundleDestination)).rejects.toThrow(/ENOENT/);
    expect(await readdir(tree)).toEqual(["README.md"]);
  });

  it("drops a root .git that is a symlink or a file without following it", async () => {
    const { root, tree, bundleDestination } = await workspace();
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "wardby-result.bundle"), "not ours");
    await rm(join(tree, ".git"), { recursive: true });
    await symlink(elsewhere, join(tree, ".git"));
    expect(await takeResultBundle(tree, { bundleDestination, maxBundleBytes: 1024 })).toBe(false);
    expect(await readdir(tree)).toEqual(["README.md"]);
    expect(await readFile(join(elsewhere, "wardby-result.bundle"), "utf8")).toBe("not ours");
    await writeFile(join(tree, ".git"), "gitdir: /elsewhere\n");
    expect(await takeResultBundle(tree, { bundleDestination, maxBundleBytes: 1024 })).toBe(false);
    expect(await readdir(tree)).toEqual(["README.md"]);
  });

  it("raises vcs_result_bundle_too_large for a bundle over the limit", async () => {
    const { tree, bundleDestination } = await workspace();
    await writeFile(join(tree, ".git", "wardby-result.bundle"), "x".repeat(11));
    await expect(takeResultBundle(tree, { bundleDestination, maxBundleBytes: 10 })).rejects.toThrow(
      "vcs_result_bundle_too_large",
    );
    await expect(lstat(bundleDestination)).rejects.toThrow(/ENOENT/);
  });

  it("refuses a limit that is not a positive integer", async () => {
    const { tree, bundleDestination } = await workspace();
    await expect(takeResultBundle(tree, { bundleDestination, maxBundleBytes: 0 })).rejects.toThrow(
      "job_result_bundle_limit_invalid",
    );
  });
});
