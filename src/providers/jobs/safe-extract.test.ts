import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { safeExtract } from "./safe-extract.js";

const require = createRequire(import.meta.url);
// tar-stream's package.json only exports ".", so the low-level header encoder (needed to hand-craft
// entries the friendly pack() API refuses to build, like a symlink with a body) must be required by
// its real file path rather than the package specifier.
const tarHeaders = require("../../../node_modules/tar-stream/headers.js") as {
  encode(opts: Record<string, unknown>): Buffer | null;
};

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

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
    // Fix round 1 (I3) added a header.size pre-check (before the body is ever drained) that runs ahead
    // of this streamed per-chunk check for any entry with an honestly-reported size; both paths use the
    // same extract_size_limit code, so this rejects with it either way.
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

  // --- Fix round 1: regressions for the reviewer's findings (hostile.mts, trunc.mts, trunc2.mts, escape.mts) ---

  describe("fix round 1 regressions", () => {
    it("rejects a truncated archive (cut mid-body) instead of hanging", async () => {
      // C1: previously hung forever — `pipeline(entry, …)` on an already-destroyed streamx readable
      // never settled when the extractor's 'error' happened during the async gap before piping started.
      const full = await toBuffer(await archive([{ name: "a", body: "z".repeat(900) }]));
      const dir = await root();
      await expect(safeExtract(Readable.from([full.subarray(0, 700)]), dir, limits)).rejects.toThrow();
    }, 5000);

    it("rejects an archive truncated with no end-of-archive blocks instead of hanging", async () => {
      const full = await toBuffer(await archive([{ name: "a", body: "z".repeat(900) }]));
      const dir = await root();
      await expect(safeExtract(Readable.from([full.subarray(0, 1024)]), dir, limits)).rejects.toThrow();
    }, 5000);

    it("rejects with extract_aborted when the signal is already aborted", async () => {
      const dir = await root();
      const controller = new AbortController();
      controller.abort();
      await expect(
        safeExtract(await archive([{ name: "a", body: "x" }]), dir, limits, { signal: controller.signal }),
      ).rejects.toThrow("extract_aborted");
    });

    it("rejects a case-insensitive symlink alias escape without ever writing outside root", async () => {
      // C2a: on a case-insensitive filesystem, "d/T" (a symlink recorded but not yet created during
      // phase 1) and "d/t" (a real directory phase 1 *does* create, to hold "d/t/x/pwned") are the same
      // path. Two-phase extraction means phase 1 never has an on-disk symlink to write through — the
      // file lands inside root — and the collision instead surfaces when phase 2 tries to materialize
      // the "d/T" symlink (EEXIST) or, on a case-sensitive filesystem, when the physical chain through
      // "d/s" is validated (extract_symlink_escape). Either way it must reject and stay contained.
      const outer = await mkdtemp(join(tmpdir(), "wardby-extract-outer-"));
      roots.push(outer);
      const targetRoot = join(outer, "root");
      await mkdir(targetRoot);
      const archived = await archive([
        { name: "d/", type: "directory" },
        { name: "d/s", type: "symlink", linkname: ".." },
        { name: "d/T", type: "symlink", linkname: "s/.." },
        { name: "d/t/x/pwned", body: "OUTSIDE" },
      ]);
      await expect(safeExtract(archived, targetRoot, limits)).rejects.toThrow();
      expect(await readdir(outer)).toEqual(["root"]);
    });

    it("rejects a chained in-tree symlink that physically resolves outside root (extract_symlink_escape)", async () => {
      // C2b: lexically "s/.." from "d" looks like it stays at "d" (inside root), but "s" is itself a
      // symlink to "..", so the physically-resolved target is one level *above* root. Only a real
      // filesystem walk (readlink + lstat), not a lexical string check, catches this.
      const dir = await root();
      await expect(
        safeExtract(
          await archive([
            { name: "d/", type: "directory" },
            { name: "d/s", type: "symlink", linkname: ".." },
            { name: "d/t", type: "symlink", linkname: "s/.." },
          ]),
          dir,
          limits,
        ),
      ).rejects.toThrow("extract_symlink_escape");
    });

    it("accepts legitimate in-tree relative symlinks, including a dangling one", async () => {
      const dir = await root();
      await safeExtract(
        await archive([
          { name: "c/", type: "directory" },
          { name: "a/", type: "directory" },
          { name: "a/b", type: "symlink", linkname: "../c" },
          { name: "a/x", type: "symlink", linkname: "../missing" },
        ]),
        dir,
        limits,
      );
      expect(await readlink(join(dir, "a/b"))).toBe("../c");
      expect(await readlink(join(dir, "a/x"))).toBe("../missing");
    });

    it("rejects a symlink entry whose declared body size exceeds maxBytes (extract_size_limit)", async () => {
      // I3: a symlink (or any non-file type) can still carry a body up to its declared header.size; the
      // old code drained it via resume() without ever counting it toward maxBytes.
      const bodySize = 4096;
      const header = tarHeaders.encode({
        name: "big-link",
        type: "symlink",
        linkname: "x",
        size: bodySize,
        mode: 0o777,
        mtime: new Date(),
        uid: 0,
        gid: 0,
      });
      if (!header) throw new Error("failed to encode test header");
      const body = Buffer.alloc(bodySize, "y");
      const endOfArchive = Buffer.alloc(1024);
      const archived = Buffer.concat([header, body, endOfArchive]);
      const dir = await root();
      await expect(safeExtract(Readable.from([archived]), dir, { maxBytes: 1024, maxEntries: 10 })).rejects.toThrow(
        "extract_size_limit",
      );
    });

    it("rejects a file nested under an already-extracted file as a duplicate (extract_duplicate_entry)", async () => {
      // I4: previously surfaced a raw ENOTDIR fs error (including the absolute staging path) instead of
      // a fixed extract_* code.
      const dir = await root();
      await expect(
        safeExtract(
          await archive([
            { name: "x", body: "1" },
            { name: "x/y/z", body: "2" },
          ]),
          dir,
          limits,
        ),
      ).rejects.toThrow("extract_duplicate_entry");
    });

    it("rejects a path that only becomes traversal after PAX long-name decoding", async () => {
      const dir = await root();
      await expect(
        safeExtract(await archive([{ name: `../${"a".repeat(200)}`, body: "x" }]), dir, limits),
      ).rejects.toThrow("extract_path_invalid");
    });

    it("rejects a directory then a file at the same path as a duplicate", async () => {
      const dir = await root();
      await expect(
        safeExtract(
          await archive([
            { name: "a/", type: "directory" },
            { name: "a", body: "1" },
          ]),
          dir,
          limits,
        ),
      ).rejects.toThrow("extract_duplicate_entry");
    });

    it("strips setuid/world-writable header modes to 0755/0644 regardless of umask", async () => {
      const originalUmask = process.umask(0o077);
      try {
        const dir = await root();
        await safeExtract(
          await archive([
            { name: "s", body: "x", mode: 0o6777 },
            { name: "dd/", type: "directory", mode: 0o7777 },
          ]),
          dir,
          limits,
        );
        expect((await stat(join(dir, "s"))).mode & 0o7777).toBe(0o755);
        expect((await stat(join(dir, "dd"))).mode & 0o7777).toBe(0o755);
      } finally {
        process.umask(originalUmask);
      }
    });

    it("forces implicitly-created ancestor directories to 0755 regardless of umask", async () => {
      // Fix round 2: "a/b/c.txt" has no preceding explicit directory entry for "a" or "a/b", so
      // recursive mkdir creates both implicitly. mkdir's own `mode` is masked by the process umask, so
      // without an explicit chmod pass over the newly-created ancestors, these could end up more
      // restrictive than 0755.
      const originalUmask = process.umask(0o077);
      try {
        const dir = await root();
        await safeExtract(await archive([{ name: "a/b/c.txt", body: "x" }]), dir, limits);
        expect((await stat(join(dir, "a"))).mode & 0o777).toBe(0o755);
        expect((await stat(join(dir, "a/b"))).mode & 0o777).toBe(0o755);
      } finally {
        process.umask(originalUmask);
      }
    });

    it("maps a real EEXIST from an already-occupied path to extract_duplicate_entry", async () => {
      // Directly exercises the file-open EEXIST -> extract_duplicate_entry mapping (rule 4), independent
      // of filesystem case-folding: pre-seed root with a file at the exact path an entry will target, a
      // stand-in for a TOCTOU race against the "existing, empty root" precondition.
      const dir = await root();
      await writeFile(join(dir, "a"), "pre-existing");
      await expect(safeExtract(await archive([{ name: "a", body: "new" }]), dir, limits)).rejects.toThrow(
        "extract_duplicate_entry",
      );
    });

    it("destroys the source stream after a failure", async () => {
      const dir = await root();
      const source = await archive([{ name: "../outside", body: "x" }]);
      await expect(safeExtract(source, dir, limits)).rejects.toThrow();
      expect(source.destroyed).toBe(true);
    });

    it("rejects a phase-2a symlink-parent creation through a case-alias of an earlier symlink, leaving root's parent untouched", async () => {
      // Fix round 3 (new Critical): reviewer's round2.mts scenario A. "A" is created by phase 2a first
      // and physically resolves (via the chain d/s -> "..", A -> "d/s/..") one level above root. A later
      // symlink "a/b/evil" then needs its parent "a/b" created — on a case-insensitive filesystem, "a" is
      // the same entry as "A". The old `ensureDirectory` used `mkdir(recursive: true)` + path-based
      // `chmod`, both of which follow an existing symlink transparently: mkdir silently created "b"
      // *through* "A" outside root, and the ancestor chmod walk re-permissioned root's own parent
      // directory (0700 -> 0755). The fixed, component-by-component `ensureDirectory` never creates or
      // chmods anything it hasn't just `lstat`-verified itself to be a real, non-symlink directory, so on
      // a case-insensitive filesystem this now rejects (extract_through_symlink) before ever touching
      // anything outside root; on a case-sensitive filesystem it was already caught by phase 2b's
      // physical walk (extract_symlink_escape). Either way, root's parent must be completely unchanged.
      const outerParent = await mkdtemp(join(tmpdir(), "wardby-extract-outer-"));
      roots.push(outerParent);
      await chmod(outerParent, 0o700);
      const targetRoot = join(outerParent, "root");
      await mkdir(targetRoot);
      const archived = await archive([
        { name: "d/", type: "directory" },
        { name: "d/s", type: "symlink", linkname: ".." },
        { name: "A", type: "symlink", linkname: "d/s/.." },
        { name: "a/b/evil", type: "symlink", linkname: "../x" },
      ]);
      await expect(safeExtract(archived, targetRoot, limits)).rejects.toThrow();
      expect(await readdir(outerParent)).toEqual(["root"]);
      expect((await stat(outerParent)).mode & 0o777).toBe(0o700);
    });

    it("rejects with extract_aborted and destroys the source when aborted mid-stream, after a first entry has partially written", async () => {
      // Fix round 3 minor: the source stalls after delivering only part of a single file entry's
      // declared body (so extraction is already mid-write into that entry's FileHandle) and never sends
      // more data or ends; only the abort unblocks it.
      const dir = await root();
      const full = await toBuffer(await archive([{ name: "a", body: "z".repeat(900) }]));
      const source = new PassThrough();
      source.write(full.subarray(0, 600));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      await expect(safeExtract(source, dir, limits, { signal: controller.signal })).rejects.toThrow("extract_aborted");
      expect(source.destroyed).toBe(true);
    });
  });
});
