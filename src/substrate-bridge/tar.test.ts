import { describe, expect, it } from "vitest";
import { checkTarEntries } from "./tar.js";

function header(name: string, type: string, size = 0, linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write("ustar\0" + "00", 257);
  h.write("        ", 148);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const body = (text: string): Buffer => {
  const b = Buffer.alloc(Math.ceil(text.length / 512) * 512);
  b.write(text);
  return b;
};
const archive = (...parts: Buffer[]): Buffer => Buffer.concat([...parts, Buffer.alloc(1024)]);

describe("checkTarEntries", () => {
  it("accepts a normal tree", async () => {
    const tar = archive(
      header("./", "5"),
      header("./a/", "5"),
      header("./a/f.txt", "0", 5),
      body("hello"),
      header("./a/link", "2", 0, "f.txt"),
    );
    expect(await checkTarEntries(tar)).toEqual({ ok: true, entries: 4 });
  });
  it.each([
    ["absolute name", header("/etc/passwd", "0")],
    ["dotdot name", header("a/../../x", "0")],
    ["escaping hardlink", header("l", "1", 0, "../x")],
    ["device", header("d", "3")],
    ["fifo", header("d", "6")],
  ])("rejects %s", async (_name, entry) => {
    expect((await checkTarEntries(archive(entry))).ok).toBe(false);
  });
  it.each([
    ["absolute", "/etc/passwd"],
    ["parent-relative", "../../etc"],
    ["chained", "a/.."],
  ])("accepts a %s symlink target", async (_name, target) => {
    expect((await checkTarEntries(archive(header("l", "2", 0, target)))).ok).toBe(true);
  });
  it("allows a symlink that stays inside the tree", async () => {
    expect((await checkTarEntries(archive(header("./a/l", "2", 0, "../b")))).ok).toBe(true);
  });
  it("rejects an entry written through an earlier symlink", async () => {
    const tar = archive(header("./l", "2", 0, "sub"), header("./l/evil", "0"));
    expect((await checkTarEntries(tar)).ok).toBe(false);
  });
  it("reads a pax path override", async () => {
    const record = (key: string, value: string): string => {
      const rest = ` ${key}=${value}\n`;
      let len = rest.length + 1;
      if (String(len).length + rest.length !== len) len = String(len).length + rest.length;
      return `${len}${rest}`;
    };
    const pax = record("path", "../../escape");
    const tar = archive(header("PaxHeader", "x", pax.length), body(pax), header("safe", "0"));
    expect((await checkTarEntries(tar)).ok).toBe(false);
  });
  it("reads a GNU long name", async () => {
    const long = "../../escape\0";
    const tar = archive(header("././@LongLink", "L", long.length), body(long), header("safe", "0"));
    expect((await checkTarEntries(tar)).ok).toBe(false);
  });
  it("rejects an entry under a chained symlink and a hardlink through a symlink", async () => {
    const chain = archive(header("x", "2", 0, "a/.."), header("x/.../f", "0"));
    expect((await checkTarEntries(chain)).ok).toBe(false);
    const hard = archive(header("l", "2", 0, "/etc"), header("h", "1", 0, "l/passwd"));
    expect((await checkTarEntries(hard)).ok).toBe(false);
    const absHard = archive(header("h", "1", 0, "/etc/passwd"));
    expect((await checkTarEntries(absHard)).ok).toBe(false);
    const dotdotHard = archive(header("h", "1", 0, "a/../../x"));
    expect((await checkTarEntries(dotdotHard)).ok).toBe(false);
  });
  describe("pax records", () => {
    const rec = (key: string, value: string): string => {
      const rest = ` ${key}=${value}\n`;
      const base = Buffer.byteLength(rest);
      let len = base + String(base).length;
      if (String(len).length !== String(base).length) len = base + String(len).length;
      return `${len}${rest}`;
    };
    const withPax = (text: string): Buffer =>
      archive(header("PaxHeader", "x", Buffer.byteLength(text)), body(text), header("safe", "0"));
    it("builds byte-accurate records for the multi-byte case below", () => {
      const r = rec("comment", "\u00e9\u00e9");
      expect(Number(r.slice(0, r.indexOf(" ")))).toBe(Buffer.byteLength(r));
    });
    it("accepts well-formed records", async () => {
      expect((await checkTarEntries(withPax(rec("mtime", "123.5") + rec("path", "dir/file")))).ok).toBe(true);
    });
    it("reads record lengths in bytes, not characters", async () => {
      // A multi-byte value: a character-counting parser would mis-slice and read the next record's path.
      const text = rec("comment", "\u00e9\u00e9") + rec("path", "../escape");
      expect((await checkTarEntries(withPax(rec("comment", "\u00e9\u00e9") + rec("path", "fine/file")))).ok).toBe(true);
      expect((await checkTarEntries(withPax(text))).ok).toBe(false);
    });
    it.each([
      ["no length", "x=y\n"],
      ["length too long", "99 a=b\n"],
      ["length too short", "3 a=b\n"],
      ["missing newline", "7 a=b\nx"],
      ["no equals", "6 abc\n"],
      ["leading zero length", "012 a=bbbb\n"],
      ["trailing garbage", rec("a", "b") + "zz"],
    ])("rejects a malformed record (%s)", async (_name, text) => {
      expect((await checkTarEntries(withPax(text))).ok).toBe(false);
    });
    it.each([
      ["GNU.sparse.map", rec("GNU.sparse.map", "0,1")],
      ["unknown GNU key", rec("GNU.future", "1")],
      ["size override", rec("size", "0")],
    ])("rejects %s", async (_name, text) => {
      expect((await checkTarEntries(withPax(text))).ok).toBe(false);
    });
    it("rejects a global header that sets a path", async () => {
      const text = rec("path", "elsewhere");
      const tar = archive(header("g", "g", Buffer.byteLength(text)), body(text), header("safe", "0"));
      expect((await checkTarEntries(tar)).ok).toBe(false);
    });
  });
  it("rejects a char device", async () => {
    expect((await checkTarEntries(archive(header("d", "3")))).ok).toBe(false);
    expect((await checkTarEntries(archive(header("d", "4")))).ok).toBe(false);
  });
  it("rejects a truncated archive", async () => {
    expect((await checkTarEntries(header("f", "0", 1000))).ok).toBe(false);
  });
});
