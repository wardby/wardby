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
    ["absolute symlink", header("l", "2", 0, "/etc")],
    ["escaping symlink", header("l", "2", 0, "../../etc")],
    ["escaping hardlink", header("l", "1", 0, "../x")],
    ["device", header("d", "3")],
    ["fifo", header("d", "6")],
  ])("rejects %s", async (_name, entry) => {
    expect((await checkTarEntries(archive(entry))).ok).toBe(false);
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
  it("rejects a truncated archive", async () => {
    expect((await checkTarEntries(header("f", "0", 1000))).ok).toBe(false);
  });
});
