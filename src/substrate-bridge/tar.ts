/**
 * The tool bridge's tar helpers. The image carries only dist/substrate-bridge/, so the seed check
 * and the exclude rendering live here instead of reusing src/providers/jobs/safe-extract.ts (which
 * needs the tar-stream package) and src/coding/collect-exclude.ts; tests keep the exclude rendering equal.
 *
 * The seed comes from the trusted launcher through the proxy, so this is defence in depth: before
 * `tar -x` runs, every entry's header is read and an archive is refused when any entry has an
 * absolute or ".." name, a device/fifo type, a hardlink out of the tree or through a symlink, or a path that
 * runs through a symlink the archive itself creates. Symlinks may have any target. Anything the check
 * does not understand (malformed or sparse/size pax records) is refused.
 */
import { open } from "node:fs/promises";

export interface CollectExclusions {
  names: readonly string[];
  paths: readonly string[];
}

/** GNU tar options for `tar -C <workspace> -cf <file> .` (same output as src/coding/collect-exclude.ts). */
export function tarExcludeArgs(exclusions: CollectExclusions): string[] {
  return [
    "--no-anchored",
    ...exclusions.names.map((name) => `--exclude=${name}`),
    "--anchored",
    ...exclusions.paths.map((path) => `--exclude=./${path}`),
  ];
}

/** Parses a tool-setup `collectExclude`; undefined when it is not the {names, paths} shape of safe strings. */
export function parseCollectExclusions(value: unknown): CollectExclusions | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { names, paths } = value as { names?: unknown; paths?: unknown };
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length <= 256 && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 512);
  if (!strings(names) || !strings(paths)) return undefined;
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u001F\u007F]/;
  if ([...names, ...paths].some((s) => control.test(s))) return undefined;
  if (names.some((n) => n.includes("/") || n === "." || n === "..")) return undefined;
  if (paths.some((p) => p.startsWith("/") || p.split("/").some((part) => part === "" || part === "." || part === "..")))
    return undefined;
  return { names, paths };
}

export type TarCheck = { ok: true; entries: number } | { ok: false; reason: string };

interface Source {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

const BLOCK = 512;
const MAX_ENTRIES = 1_000_000;
const MAX_META_BYTES = 64 * 1024;

const cstring = (buf: Buffer): string => {
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? buf.length : end).toString("utf8");
};

function parseSize(field: Buffer): number | undefined {
  if (field[0] & 0x80) return undefined; // base-256 sizes are not produced by the launcher
  const text = cstring(field).trim();
  if (!/^[0-7]+$/.test(text)) return text === "" ? 0 : undefined;
  return parseInt(text, 8);
}

function cleanName(raw: string): string | undefined {
  if (raw.startsWith("/") || raw.includes("\0")) return undefined;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) return undefined;
  return parts.join("/");
}

/** True when a proper parent prefix of `name` is a symlink the archive itself creates. */
function throughSymlink(name: string, symlinks: ReadonlySet<string>): boolean {
  const segments = name.split("/");
  for (let i = 1; i < segments.length; i++) if (symlinks.has(segments.slice(0, i).join("/"))) return true;
  return false;
}

/**
 * Parses pax records ("<decimal length> <key>=<value>\n", length counting its own digits) on the
 * raw bytes. Returns undefined on anything malformed, so the caller fails closed.
 */
function paxRecords(data: Buffer): Map<string, string> | undefined {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0 || space - pos > 10) return undefined;
    const digits = data.subarray(pos, space).toString("latin1");
    if (!/^[1-9][0-9]*$/.test(digits)) return undefined;
    const length = Number(digits);
    if (length <= space - pos + 1 || pos + length > data.length) return undefined;
    if (data[pos + length - 1] !== 0x0a) return undefined;
    const record = data.subarray(space + 1, pos + length - 1);
    const eq = record.indexOf(0x3d);
    if (eq < 1) return undefined;
    const key = record.subarray(0, eq).toString("utf8");
    if (records.has(key)) return undefined;
    records.set(key, record.subarray(eq + 1).toString("utf8"));
    pos += length;
  }
  return records;
}

/** Pax keys this check does not understand are refused: sparse maps and size overrides change what tar reads. */
function paxKeysUnderstood(records: Map<string, string>): boolean {
  for (const key of records.keys()) {
    if (key.startsWith("GNU.")) return false;
    if (key === "size" || key === "hdrcharset") return false;
  }
  return true;
}

async function check(source: Source): Promise<TarCheck> {
  const symlinks = new Set<string>();
  let offset = 0;
  let entries = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let paxPath: string | undefined;
  let paxLink: string | undefined;
  const bad = (reason: string): TarCheck => ({ ok: false, reason });
  for (;;) {
    if (offset >= source.size) return { ok: true, entries }; // no end marker: tar tolerates it
    const header = await source.read(offset, BLOCK);
    if (header.length < BLOCK) return bad("truncated");
    if (header.every((b) => b === 0)) return { ok: true, entries };
    const size = parseSize(header.subarray(124, 136));
    if (size === undefined) return bad("size");
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156]);
    const dataStart = offset + BLOCK;
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + size > source.size) return bad("truncated");
    if (type === "L" || type === "K" || type === "x") {
      if (size > MAX_META_BYTES) return bad("meta_too_large");
      const text = cstring(await source.read(dataStart, size));
      if (type === "L") longName = text;
      else if (type === "K") longLink = text;
      else {
        const records = paxRecords(await source.read(dataStart, size));
        if (!records || !paxKeysUnderstood(records)) return bad("pax");
        paxPath = records.get("path");
        paxLink = records.get("linkpath");
      }
      offset = next;
      continue;
    }
    if (type === "g") {
      // A global header would apply to every later entry: only plain, understood records are allowed.
      if (size > MAX_META_BYTES) return bad("meta_too_large");
      const records = paxRecords(await source.read(dataStart, size));
      if (!records || !paxKeysUnderstood(records) || records.has("path") || records.has("linkpath")) return bad("pax");
      offset = next;
      continue;
    }
    if (++entries > MAX_ENTRIES) return bad("too_many_entries");
    const ustar = header.subarray(257, 262).toString("latin1") === "ustar";
    const prefix = ustar ? cstring(header.subarray(345, 500)) : "";
    const base = cstring(header.subarray(0, 100));
    const rawName = paxPath ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    const rawLink = paxLink ?? longLink ?? cstring(header.subarray(157, 257));
    paxPath = paxLink = longName = longLink = undefined;
    const name = cleanName(rawName);
    if (name === undefined) return bad("name");
    if (!["0", "5", "1", "2", "7"].includes(type)) return bad("type");
    if (throughSymlink(name, symlinks)) return bad("through_symlink");
    if (type === "2") {
      // Any target is accepted (real repositories have absolute and ".." links); nothing is ever written through one.
      symlinks.add(name);
    } else if (type === "1") {
      const target = cleanName(rawLink);
      if (target === undefined || target === "" || throughSymlink(target, symlinks)) return bad("hardlink");
    }
    offset = next;
  }
}

export function checkTarEntries(archive: Buffer): Promise<TarCheck> {
  return check({ size: archive.length, read: async (o, l) => archive.subarray(o, o + l) });
}

export async function checkTarFile(path: string): Promise<TarCheck> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    return await check({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      },
    });
  } finally {
    await handle.close();
  }
}
