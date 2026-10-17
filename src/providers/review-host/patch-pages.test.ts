import { describe, expect, it } from "vitest";
import { PatchCursorError } from "./types.js";
import { pagePatches, reviewGroup, reviewOrder, type PatchSource } from "./patch-pages.js";

const HEAD = "a".repeat(40);
const file = (filename: string, changes = 1): PatchSource => ({
  filename,
  status: "modified",
  additions: changes,
  deletions: 0,
  changes,
});
const patches: Record<string, string> = {};
const load = async (f: PatchSource) => patches[f.filename];
const page = (files: PatchSource[], budget: number, cursor?: string) =>
  pagePatches(files, { budget, cursor, headSha: HEAD, comparedFrom: null }, load);

describe("reviewGroup", () => {
  it("puts source and tests in code, and docs, help, lockfiles, generated files and fixtures in other", () => {
    for (const path of [
      "src/core/runner.ts",
      "src/core/runner.test.ts",
      "knockknock/app.py",
      "tests/test_app.py",
      "Dockerfile",
      "prisma/migrations/1_x/migration.sql",
    ]) {
      expect(reviewGroup(path)).toBe("code");
    }
    for (const path of [
      "README.md",
      "docs/guide.md",
      "help/errors/x.md",
      "package-lock.json",
      "yarn.lock",
      "poetry.lock",
      "uv.lock",
      "go.sum",
      "src/generated/prisma/client.ts",
      "dist/index.js",
      "web/app.min.js",
      "src/__snapshots__/a.snap",
      "test/fixtures/big.json",
      "assets/logo.svg",
      "CHANGELOG.md",
    ]) {
      expect(reviewGroup(path)).toBe("other");
    }
  });
});

describe("reviewOrder", () => {
  it("moves code first and keeps the host's order within each group", () => {
    const files = ["docs/a.md", "src/b.ts", "package-lock.json", "src/a.ts", "help/c.md"].map((f) => file(f));
    expect(reviewOrder(files).map((f) => f.filename)).toEqual([
      "src/b.ts",
      "src/a.ts",
      "docs/a.md",
      "package-lock.json",
      "help/c.md",
    ]);
  });
});

describe("pagePatches", () => {
  it("fills code before docs whose patches alone exceed the budget", async () => {
    patches["docs/huge.md"] = "+x\n".repeat(50_000);
    patches["src/app.ts"] = "+code\n";
    const result = await page([file("docs/huge.md", 50_000), file("src/app.ts")], 1_000);
    expect(result.files.map((f) => [f.filename, f.patchStatus])).toEqual([
      ["src/app.ts", "complete"],
      ["docs/huge.md", "partial"],
    ]);
    expect(result.patchesComplete).toBe(false);
    expect(result.truncatedFiles).toEqual(["docs/huge.md"]);
    expect(result.remainingPatchFiles).toBe(1);
    expect(result.nextPatchCursor).not.toBeNull();
  });

  it("pages through every patch with the cursor until nothing is left", async () => {
    for (const name of ["src/a.ts", "src/b.ts", "src/c.ts"]) patches[name] = `+${name}\n`.repeat(20);
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"].map((f) => file(f, 20));
    const seen = new Map<string, string>();
    let cursor: string | undefined;
    for (let calls = 0; calls < 20; calls++) {
      const result = await page(files, 300, cursor);
      for (const f of result.files) {
        if (f.patchStatus === "complete" || f.patchStatus === "partial")
          seen.set(f.filename, (seen.get(f.filename) ?? "") + f.patch);
      }
      if (!result.nextPatchCursor) {
        expect(result.patchesComplete).toBe(true);
        break;
      }
      cursor = result.nextPatchCursor;
    }
    for (const name of ["src/a.ts", "src/b.ts", "src/c.ts"]) expect(seen.get(name)).toBe(patches[name]);
  });

  it("splits one oversized file into parts on line boundaries", async () => {
    patches["src/big.ts"] = Array.from({ length: 100 }, (_, i) => `+line ${i}\n`).join("");
    const first = await page([file("src/big.ts", 100)], 200);
    expect(first.files[0]).toMatchObject({ patchStatus: "partial", patchOffset: 0, patchContinues: true });
    expect(first.files[0].patch.endsWith("\n")).toBe(true);
    const second = await page([file("src/big.ts", 100)], 200, first.nextPatchCursor!);
    expect(second.files[0]).toMatchObject({ patchStatus: "partial", patchOffset: first.files[0].patch.length });
    let cursor = second.nextPatchCursor;
    let last = second;
    while (cursor) {
      last = await page([file("src/big.ts", 100)], 200, cursor);
      cursor = last.nextPatchCursor;
    }
    expect(last.files[0]).toMatchObject({ patchStatus: "partial", patchContinues: false });
  });

  it("marks a file the host has no patch for unavailable, so patchesComplete stays false", async () => {
    delete patches["src/gen.ts"];
    const result = await page([file("src/gen.ts", 9_000)], 1_000);
    expect(result.files[0]).toMatchObject({ patchStatus: "unavailable", patchTruncated: true, patch: "" });
    expect(result.patchesComplete).toBe(false);
    expect(result.nextPatchCursor).toBeNull();
    expect(result.truncatedFiles).toEqual(["src/gen.ts"]);
  });

  it("treats a file with no line changes as empty, not truncated", async () => {
    delete patches["src/moved.ts"];
    const result = await page([file("src/moved.ts", 0)], 1_000);
    expect(result.files[0]).toMatchObject({ patchStatus: "empty", patchTruncated: false });
    expect(result.patchesComplete).toBe(true);
  });

  it("loads only the files on this page", async () => {
    const loaded: string[] = [];
    for (const name of ["src/a.ts", "src/b.ts"]) patches[name] = "+x\n".repeat(100);
    await pagePatches(
      [file("src/a.ts", 100), file("src/b.ts", 100)],
      { budget: 100, headSha: HEAD, comparedFrom: null },
      async (f) => {
        loaded.push(f.filename);
        return patches[f.filename];
      },
    );
    expect(loaded).toEqual(["src/a.ts"]);
  });

  it("refuses a cursor for another head or compare, and a malformed one", async () => {
    patches["src/a.ts"] = "+x\n".repeat(100);
    const first = await page([file("src/a.ts", 100)], 30);
    const moved = pagePatches(
      [file("src/a.ts", 100)],
      { budget: 30, cursor: first.nextPatchCursor!, headSha: "b".repeat(40), comparedFrom: null },
      load,
    );
    await expect(moved).rejects.toEqual(new PatchCursorError("stale"));
    await expect(page([file("src/a.ts", 100)], 30, "nonsense")).rejects.toEqual(new PatchCursorError("malformed"));
  });
});
