import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitStore } from "./git-store.js";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("GitStore", () => {
  it("a reset empties the root but keeps it (in a pod the root is a mounted volume)", async () => {
    root = mkdtempSync(join(tmpdir(), "wardby-sim-root-"));
    const store = new GitStore(root);
    await store.create("acme/widgets", "main");
    await store.commit("acme/widgets", { branch: "main", files: { "a.txt": "a\n" }, message: "a", parent: null });
    expect(readdirSync(root)).not.toEqual([]);
    store.clear();
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });
});
