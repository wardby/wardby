// TEST ONLY (wardby-sim). Real package archives the real clients accept: npm's .tgz (a gzipped
// ustar tar under package/), Python wheels (a zip with a .dist-info) and sdists (a .tar.gz with
// PKG-INFO). Deterministic: fixed mtimes, so the same input gives the same bytes and digest.
import { createHash } from "node:crypto";
import { crc32, gzipSync } from "node:zlib";

const MTIME = Math.floor(Date.UTC(2026, 0, 1) / 1000);

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** A ustar archive of regular files (paths under 100 bytes). */
export function tar(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    if (Buffer.byteLength(path) > 99) throw new Error(`tar path too long: ${path}`);
    const header = Buffer.alloc(512, 0);
    header.write(path, 0, "utf8");
    header.write(octal(0o644, 8), 100, "ascii");
    header.write(octal(0, 8), 108, "ascii");
    header.write(octal(0, 8), 116, "ascii");
    header.write(octal(body.length, 12), 124, "ascii");
    header.write(octal(MTIME, 12), 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(octal(sum, 7) + " ", 148, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export function tgz(files: Record<string, string | Buffer>): Buffer {
  // mtime 0 in the gzip header keeps the bytes deterministic.
  return gzipSync(tar(files), { level: 9 });
}

/** A stored (uncompressed) zip archive. */
export function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path, "utf8");
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha512Sri(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function sha1Hex(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** An npm package tarball: package/package.json and an index.js. */
export function npmTarball(name: string, version: string, manifest: Record<string, unknown>): Buffer {
  return tgz({
    "package/package.json": `${JSON.stringify({ name, version, main: "index.js", ...manifest }, null, 2)}\n`,
    "package/index.js": `module.exports = ${JSON.stringify(`${name}@${version}`)};\n`,
  });
}

/** PEP 503 normalized name. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** A pure-Python wheel installable by pip and uv: one module, METADATA, WHEEL and RECORD. */
export function pythonWheel(name: string, version: string, requires: string[] = [], extras: string[] = []): Buffer {
  const dist = name.replace(/[-.]+/g, "_");
  const info = `${dist}-${version}.dist-info`;
  const files: Record<string, string> = {
    [`${dist}/__init__.py`]: `VERSION = ${JSON.stringify(version)}\n`,
    [`${info}/METADATA`]: [
      "Metadata-Version: 2.1",
      `Name: ${name}`,
      `Version: ${version}`,
      ...extras.map((extra) => `Provides-Extra: ${extra}`),
      ...requires.map((r) => `Requires-Dist: ${r}`),
      "",
    ].join("\n"),
    [`${info}/WHEEL`]: "Wheel-Version: 1.0\nGenerator: wardby-sim\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
  };
  const record = Object.entries(files)
    .map(([path, content]) => {
      const digest = createHash("sha256").update(content).digest("base64url");
      return `${path},sha256=${digest},${Buffer.byteLength(content)}`;
    })
    .concat(`${info}/RECORD,,`)
    .join("\n");
  files[`${info}/RECORD`] = `${record}\n`;
  return zip(files);
}

export function pythonSdist(name: string, version: string): Buffer {
  const root = `${name}-${version}`;
  return tgz({
    [`${root}/PKG-INFO`]: `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`,
    [`${root}/setup.py`]: `from setuptools import setup\nsetup(name=${JSON.stringify(name)}, version=${JSON.stringify(version)})\n`,
  });
}
