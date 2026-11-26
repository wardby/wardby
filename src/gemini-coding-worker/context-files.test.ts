import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeWorkerErrorCode } from "../coding-worker/errors.js";
import { CONTEXT_FILE_REFUSED, assertGeminiContextFilesRegular } from "./context-files.js";

const repo = async (files: Record<string, string> = {}) => {
  const root = await mkdtemp(join(tmpdir(), "gemini-context-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

describe("assertGeminiContextFilesRegular", () => {
  it("passes a tree whose context files are all regular files", async () => {
    const root = await repo({ "GEMINI.md": "x", "a/b/AGENTS.md": "y", "c/CLAUDE.md": "z", "gemini.md": "case" });
    await symlink("/etc/hostname", join(root, "a", "notes.md"));
    await expect(assertGeminiContextFilesRegular(root)).resolves.toBeUndefined();
  });

  it.each(["GEMINI.md", "AGENTS.md", "CLAUDE.md", "deep/er/GEMINI.md"])(
    "refuses %s as a symlink (e.g. to /proc/self/environ) with a safe code",
    async (path) => {
      const root = await repo({ "README.md": "r" });
      await mkdir(join(root, path, ".."), { recursive: true });
      await symlink("/proc/self/environ", join(root, path));
      const failure = await assertGeminiContextFilesRegular(root).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(safeWorkerErrorCode(failure)).toBe(CONTEXT_FILE_REFUSED);
    },
  );

  it("refuses a context file that is a directory", async () => {
    const root = await repo();
    await mkdir(join(root, "x", "CLAUDE.md"), { recursive: true });
    await expect(assertGeminiContextFilesRegular(root)).rejects.toThrow(CONTEXT_FILE_REFUSED);
  });

  it("skips .git and never follows a symlinked directory", async () => {
    const outside = await repo();
    await symlink("/proc/self/environ", join(outside, "GEMINI.md"));
    const root = await repo({ "GEMINI.md": "ok" });
    await mkdir(join(root, ".git", "x"), { recursive: true });
    await symlink("/proc/self/environ", join(root, ".git", "x", "GEMINI.md"));
    await symlink(outside, join(root, "linked"));
    await expect(assertGeminiContextFilesRegular(root)).resolves.toBeUndefined();
  });

  it("fails closed past its entry bound", async () => {
    const root = await repo({ "a.txt": "1", "b.txt": "2", "c.txt": "3" });
    await expect(assertGeminiContextFilesRegular(root, { maxEntries: 2 })).rejects.toThrow(CONTEXT_FILE_REFUSED);
  });

  it("scans every root the CLI trusts: a link in an extra repository refuses the run", async () => {
    const workspace = await repo({ "GEMINI.md": "ok" });
    const clean = await repo({ "AGENTS.md": "ok" });
    const linked = await repo({ "README.md": "r" });
    await symlink("/proc/self/environ", join(linked, "GEMINI.md"));
    await expect(assertGeminiContextFilesRegular([workspace, clean])).resolves.toBeUndefined();
    await expect(assertGeminiContextFilesRegular([workspace, clean, linked])).rejects.toThrow(CONTEXT_FILE_REFUSED);
    // A missing extra root has nothing to load either.
    await expect(
      assertGeminiContextFilesRegular([workspace, join(tmpdir(), "no-such-gemini-repo")]),
    ).resolves.toBeUndefined();
  });

  it("passes a missing workspace", async () => {
    await expect(assertGeminiContextFilesRegular(join(tmpdir(), "no-such-gemini-ws"))).resolves.toBeUndefined();
  });
});
