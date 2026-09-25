import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExclusions } from "../../coding/collect-exclude.js";
import { pruneCollectExcluded } from "./collect-prune.js";
import { validateMaterializedWorkspace } from "./docker.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pruneCollectExcluded", () => {
  it("removes excluded folders, including escaping symlinks inside them, without following links", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-prune-"));
    const outside = await mkdtemp(join(tmpdir(), "wardby-prune-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "keep.txt"), "must survive");
    await mkdir(join(root, "web", "node_modules", "react"), { recursive: true });
    await writeFile(join(root, "web", "node_modules", "react", "index.js"), "x");
    await symlink(outside, join(root, "web", "node_modules", "escape"));
    await mkdir(join(root, "web", "dist"), { recursive: true });
    await writeFile(join(root, "web", "dist", "app.js"), "built");
    await writeFile(join(root, "web", "app.ts"), "source");

    await pruneCollectExcluded(root, collectExclusions(["web/dist"]));

    expect((await readdir(join(root, "web"))).sort()).toEqual(["app.ts"]);
    expect(await readdir(outside)).toEqual(["keep.txt"]);
    await expect(validateMaterializedWorkspace(root, 1024 * 1024)).resolves.toBeUndefined();
  });
});
