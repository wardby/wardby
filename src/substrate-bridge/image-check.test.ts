import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkImage, ImageIncompleteError } from "./image-check.js";

const asRoot = process.getuid?.() === 0;

describe("checkImage", () => {
  let dir: string;
  let gnuTar: string;
  let bsdTar: string;
  let slowTar: string;
  let runner: string;

  const script = async (name: string, body: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "image-check-"));
    gnuTar = await script("gnu-tar", 'echo "tar (GNU tar) 1.35"');
    bsdTar = await script("bsd-tar", 'echo "bsdtar 3.5.3 - libarchive 3.5.3"');
    slowTar = await script("slow-tar", 'sleep 5\necho "tar (GNU tar) 1.35"');
    runner = join(dir, "main.mjs");
    await writeFile(runner, "export {};\n");
  });

  afterEach(async () => {
    // A read-only folder made writable again, so the folder can be removed.
    for (const path of [join(dir, "ro"), join(dir, "ro-parent")]) await chmod(path, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  const good = () => ({
    runnerEntry: runner,
    tar: gnuTar,
    workspace: join(dir, "ws"),
    runDirs: [join(dir, "run", "tool")],
    uid: 10001,
  });

  it("finds nothing missing, and creates the directories", async () => {
    expect(await checkImage(good())).toBeUndefined();
    expect(existsSync(join(dir, "ws"))).toBe(true);
    expect(existsSync(join(dir, "run", "tool"))).toBe(true);
  });

  it("reports root (uid 0) as user, before anything else", async () => {
    expect(await checkImage({ ...good(), uid: 0 })).toBe("user");
    expect(
      await checkImage({ ...good(), uid: 0, runnerEntry: join(dir, "missing.mjs"), tar: join(dir, "no-tar") }),
    ).toBe("user");
    // Nothing else ran: the directories were not created.
    expect(existsSync(join(dir, "ws"))).toBe(false);
  });

  it("passes uid 10001", async () => {
    expect(await checkImage({ ...good(), uid: 10001 })).toBeUndefined();
  });

  it("defaults to the process's uid", async () => {
    const { uid: _uid, ...withoutUid } = good();
    expect(await checkImage(withoutUid)).toBe(asRoot ? "user" : undefined);
  });

  it("reports a missing runner first, before a bad tar", async () => {
    expect(await checkImage({ ...good(), runnerEntry: join(dir, "missing.mjs") })).toBe("runner");
    expect(await checkImage({ ...good(), runnerEntry: join(dir, "missing.mjs"), tar: bsdTar })).toBe("runner");
  });

  it("reports a runner path that is a directory", async () => {
    const folder = join(dir, "runner-dir");
    await mkdir(folder);
    expect(await checkImage({ ...good(), runnerEntry: folder })).toBe("runner");
  });

  it("reports a tar that is not GNU tar", async () => {
    expect(await checkImage({ ...good(), tar: bsdTar })).toBe("tar");
  });

  it("reports a missing tar", async () => {
    expect(await checkImage({ ...good(), tar: join(dir, "no-tar") })).toBe("tar");
  });

  it("reports a tar that never answers, at its timeout", async () => {
    const startedAt = Date.now();
    expect(await checkImage({ ...good(), tar: slowTar }, { tarTimeoutMs: 100 })).toBe("tar");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it.skipIf(asRoot)("reports an unwritable workspace", async () => {
    await mkdir(join(dir, "ro"), { mode: 0o555 });
    await chmod(join(dir, "ro"), 0o555);
    expect(await checkImage({ ...good(), workspace: join(dir, "ro") })).toBe("workspace");
  });

  it.skipIf(asRoot)("reports a run directory it cannot create", async () => {
    await mkdir(join(dir, "ro-parent"));
    await chmod(join(dir, "ro-parent"), 0o555);
    expect(await checkImage({ ...good(), runDirs: [join(dir, "run", "ok"), join(dir, "ro-parent", "tool")] })).toBe(
      "run_dir",
    );
  });
});

describe("ImageIncompleteError", () => {
  it("carries a fixed code and the item", async () => {
    let closed = false;
    const error = new ImageIncompleteError("tar", async () => {
      closed = true;
    });
    expect(error.code).toBe("substrate_bridge_image_incomplete");
    expect(error.message).toBe("substrate_bridge_image_incomplete");
    expect(error.item).toBe("tar");
    expect(error.reported).toBe(true);
    expect(new ImageIncompleteError("user", async () => undefined, false).reported).toBe(false);
    await error.close();
    expect(closed).toBe(true);
  });
});
