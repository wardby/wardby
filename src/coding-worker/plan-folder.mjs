// The plan folder of a coding run (docs: agent plan documents), shared by the Codex driver
// (driver.ts, main.ts) and Claude Code's tool runner (claude-tool-runner/main.mjs), which both
// ship this file as is: node builtins only. The folder is agent-writable, so nothing in it is
// followed: every entry is lstat'ed, files are opened O_NOFOLLOW and checked again once open.

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";

/** protocol.ts PLAN_FOLDER_PATH (plan-folder.test.ts keeps the two equal). */
export const PLAN_ROOT = "/tmp/wardby-plan";
/** protocol.ts PLAN_FILES_LIMITS (plan-folder.test.ts keeps the two equal). */
export const PLAN_LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPathBytes: 512,
  maxDepth: 4,
  maxSkipped: 50,
});
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const DECODER = new TextDecoder("utf-8", { fatal: true });

/** protocol.ts isSafePlanPath (plan-folder.test.ts keeps the two in step). */
export function isSafePlanPath(path) {
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path) > PLAN_LIMITS.maxPathBytes) return false;
  if (path.startsWith("/") || path.includes("\\") || CONTROL.test(path)) return false;
  const segments = path.split("/");
  if (segments.length > PLAN_LIMITS.maxDepth) return false;
  return segments.every((segment) => segment !== "" && !segment.startsWith("."));
}

/** The root as a real directory (created 0700 when missing); throws plan_folder_invalid otherwise. */
async function ensureRoot(root) {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("plan_folder_invalid");
    await mkdir(root, { mode: 0o700 });
    return;
  }
  if (!info.isDirectory()) throw new Error("plan_folder_invalid");
}

export async function placePlanFiles(root, files) {
  for (const file of files) if (!isSafePlanPath(file.path)) throw new Error("plan_path_invalid");
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error("plan_path_invalid");
    seen.add(file.path);
  }
  // A path that is also a parent directory of another (a and a/b) cannot both exist.
  for (const path of seen) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1)
      if (seen.has(parts.slice(0, i).join("/"))) throw new Error("plan_path_invalid");
  }
  try {
    await placeValidated(root, files);
  } catch (error) {
    if (typeof error?.message === "string" && /^plan_[a-z_]+$/.test(error.message)) throw error;
    throw new Error("plan_folder_invalid");
  }
}

async function placeValidated(root, files) {
  await ensureRoot(root);
  for (const file of files) {
    const segments = file.path.split("/");
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      dir = join(dir, segment);
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (!(await lstat(dir)).isDirectory()) throw new Error("plan_folder_invalid");
    }
    const handle = await open(join(root, file.path), CREATE_FLAGS, 0o600);
    try {
      await handle.writeFile(Buffer.from(file.contentBase64, "base64"));
    } finally {
      await handle.close();
    }
  }
}

/** One regular file's bytes, "too_large", or null when it changed into anything else. */
async function readRegular(path, max) {
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (info.size > max) return "too_large";
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > max ? "too_large" : buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function collectPlanFolder(root) {
  try {
    const info = await lstat(root);
    if (!info.isDirectory()) return { status: "error", error: "plan_folder_invalid" };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "ok", files: [], skipped: [], skippedUnnamed: 0 };
    return { status: "error", error: "plan_folder_invalid" };
  }
  const files = [];
  const skipped = [];
  let skippedUnnamed = 0;
  let total = 0;
  let entries = 0;
  const skip = (path) => {
    if (isSafePlanPath(path) && skipped.length < PLAN_LIMITS.maxSkipped) skipped.push(path);
    else skippedUnnamed += 1;
  };
  const walk = async (dir, prefix, depth) => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      // Each entry counts toward the bound, so a folder of millions of empty entries stops early.
      if (++entries > PLAN_LIMITS.maxFiles * 4) return "too_large";
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      const info = await lstat(full);
      if (info.isDirectory()) {
        if (name.startsWith(".") || depth + 1 >= PLAN_LIMITS.maxDepth) {
          skippedUnnamed += 1;
          continue;
        }
        if ((await walk(full, path, depth + 1)) === "too_large") return "too_large";
        continue;
      }
      if (!info.isFile() || info.nlink > 1 || !isSafePlanPath(path)) {
        skip(path);
        continue;
      }
      if (files.length >= PLAN_LIMITS.maxFiles) return "too_large";
      if (total + info.size > PLAN_LIMITS.maxTotalBytes) return "too_large";
      const bytes = await readRegular(full, PLAN_LIMITS.maxFileBytes);
      if (bytes === "too_large") return "too_large";
      if (bytes === null) {
        skip(path);
        continue;
      }
      try {
        DECODER.decode(bytes);
      } catch {
        skip(path);
        continue;
      }
      total += bytes.length;
      if (total > PLAN_LIMITS.maxTotalBytes) return "too_large";
      files.push({ path, contentBase64: bytes.toString("base64") });
    }
    return "ok";
  };
  try {
    if ((await walk(root, "", 0)) === "too_large") return { status: "error", error: "plan_too_large" };
  } catch {
    return { status: "error", error: "plan_folder_invalid" };
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { status: "ok", files, skipped, skippedUnnamed };
}
