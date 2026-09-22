import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceDirectoryFromStaging } from "./workspace-swap.js";

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
