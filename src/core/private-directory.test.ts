import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDirectory } from "./private-directory.js";

const posix = process.getuid !== undefined;

describe("ensurePrivateDirectory", () => {
  const roots: string[] = [];
  async function scratch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wardby-private-dir-"));
    roots.push(root);
    return root;
  }
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("creates a missing directory", async () => {
    const path = join(await scratch(), "state");
    await ensurePrivateDirectory(path);
    await expect(ensurePrivateDirectory(path)).resolves.toBeUndefined();
  });

  it("refuses a symlink, even to a directory the process owns", async () => {
    const root = await scratch();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    await expect(ensurePrivateDirectory(join(root, "link"))).rejects.toThrow(/not a symlink/);
  });

  it.runIf(posix)("refuses a directory other users can write to", async () => {
    const path = join(await scratch(), "shared");
    await mkdir(path);
    await chmod(path, 0o777);
    await expect(ensurePrivateDirectory(path)).rejects.toThrow(/writable by other users/);
  });

  it.runIf(posix)("allows a group-writable directory, as a Kubernetes fsGroup volume is", async () => {
    const path = join(await scratch(), "fsgroup");
    await mkdir(path);
    await chmod(path, 0o2770);
    await expect(ensurePrivateDirectory(path)).resolves.toBeUndefined();
  });
});
