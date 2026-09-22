import { lstat, mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { safeExtract } from "./safe-extract.js";

type Entry = {
  name: string;
  type?: "file" | "directory" | "symlink" | "link" | "fifo" | "character-device";
  body?: string;
  linkname?: string;
  mode?: number;
};

async function archive(entries: Entry[]): Promise<Readable> {
  const pack = tar.pack();
  for (const e of entries) {
    const header = { name: e.name, type: e.type ?? "file", mode: e.mode ?? 0o644, linkname: e.linkname };
    const hasBody = !e.type || e.type === "file";
    await new Promise<void>((resolveEntry, reject) => {
      const done = (err?: Error | null): void => (err ? reject(err) : resolveEntry());
      if (hasBody) {
        pack.entry(header, e.body ?? "", done);
      } else {
        pack.entry(header, done);
      }
    });
  }
  pack.finalize();
  return pack as unknown as Readable;
}

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wardby-extract-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const limits = { maxBytes: 1024 * 1024, maxEntries: 100 };

describe("safeExtract", () => {
  it("extracts files, directories, executable bits, and in-tree symlinks", async () => {
    const dir = await root();
    await safeExtract(
      await archive([
        { name: "./", type: "directory" },
        { name: "./src/", type: "directory" },
        { name: "./src/a.txt", body: "hello" },
        { name: "./run.sh", body: "#!/bin/sh", mode: 0o755 },
        { name: "./link", type: "symlink", linkname: "src/a.txt" },
      ]),
      dir,
      limits,
    );
    expect(await readFile(join(dir, "src/a.txt"), "utf8")).toBe("hello");
    expect((await stat(join(dir, "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, "src/a.txt"))).mode & 0o777).toBe(0o644);
    expect(await readlink(join(dir, "link"))).toBe("src/a.txt");
  });

  const rejects: Array<[string, Entry[], string]> = [
    ["absolute path", [{ name: "/etc/passwd", body: "x" }], "extract_path_invalid"],
    ["parent traversal", [{ name: "../escape", body: "x" }], "extract_path_invalid"],
    ["nested traversal", [{ name: "a/../../escape", body: "x" }], "extract_path_invalid"],
    [
      "hard link",
      [
        { name: "a", body: "x" },
        { name: "b", type: "link", linkname: "a" },
      ],
      "extract_special_entry",
    ],
    ["fifo", [{ name: "pipe", type: "fifo" }], "extract_special_entry"],
    ["device", [{ name: "dev", type: "character-device" }], "extract_special_entry"],
    ["absolute symlink", [{ name: "l", type: "symlink", linkname: "/etc" }], "extract_symlink_escape"],
    ["escaping symlink", [{ name: "l", type: "symlink", linkname: "../../etc" }], "extract_symlink_escape"],
    [
      "write through a symlink",
      [
        { name: "sub/", type: "directory" },
        { name: "l", type: "symlink", linkname: "sub" },
        { name: "l/file", body: "x" },
      ],
      "extract_through_symlink",
    ],
    [
      "duplicate file",
      [
        { name: "a", body: "1" },
        { name: "a", body: "2" },
      ],
      "extract_duplicate_entry",
    ],
  ];
  it.each(rejects)("rejects %s", async (_label, entries, code) => {
    const dir = await root();
    await expect(safeExtract(await archive(entries), dir, limits)).rejects.toThrow(code);
  });

  it("rejects writing through an already-extracted symlink at a deeper nesting (a -> a/b/c)", async () => {
    const dir = await root();
    await expect(
      safeExtract(
        await archive([
          { name: "sub/", type: "directory" },
          { name: "a", type: "symlink", linkname: "sub" },
          { name: "a/b/c", body: "x" },
        ]),
        dir,
        limits,
      ),
    ).rejects.toThrow("extract_through_symlink");
  });

  it("enforces the byte limit while streaming", async () => {
    const dir = await root();
    await expect(
      safeExtract(await archive([{ name: "big", body: "x".repeat(2048) }]), dir, { maxBytes: 1024, maxEntries: 10 }),
    ).rejects.toThrow("extract_size_limit");
  });

  it("enforces the entry limit", async () => {
    const dir = await root();
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, body: "x" }));
    await expect(safeExtract(await archive(many), dir, { maxBytes: 1024, maxEntries: 3 })).rejects.toThrow(
      "extract_entry_limit",
    );
  });

  it("never writes outside the root when rejecting", async () => {
    const dir = await root();
    await expect(safeExtract(await archive([{ name: "../outside", body: "x" }]), dir, limits)).rejects.toThrow();
    await expect(lstat(join(dir, "..", "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
