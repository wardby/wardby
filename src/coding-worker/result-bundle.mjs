// The result bundle of a run with git history (#536), shared by the Codex driver (driver.ts) and the
// Claude Code tool runner (claude-tool-runner/main.mjs), which both ship this file as is: node
// builtins only.
//
// The repository's `.git` is agent-writable, so git never runs against it. HEAD and the ref it names
// are read here as plain text, and git runs in a scratch repository of our own, outside the
// workspace, whose objects reach the agent's object store through `objects/info/alternates`. The
// agent's config, hooks, attributes, refs, commit-graph, multi-pack index and its own alternates
// are never read. The control plane validates the bundle completely anyway: it is untrusted bytes.

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the bundle is written: `<repo>/.git/wardby-result.bundle`, which the collector takes. */
export const RESULT_BUNDLE_NAME = "wardby-result.bundle";
/** The bundle's one head (`git bundle list-heads` prints `<sha> refs/wardby/bundle-head`). */
export const BUNDLE_HEAD_REF = "refs/wardby/bundle-head";
/** HEAD, a loose ref file and packed-refs are refused above this size. */
export const MAX_REF_FILE_BYTES = 64 * 1024;
/** The shallow file: one 41-byte line per boundary commit. */
export const MAX_SHALLOW_BYTES = 4 * 1024 * 1024;
/** `git bundle create`; the scratch steps before it take the short limit. */
export const BUNDLE_TIMEOUT_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 60 * 1000;
const VERSION_TIMEOUT_MS = 10 * 1000;

const COMMIT = /^[0-9a-f]{40}$/;
const REF_NAME = /^refs\/[A-Za-z0-9._/-]+$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/** Settings every git call here carries on its command line, ahead of anything a config could say. */
const SAFE_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.commitGraph=false",
  "core.multiPackIndex=false",
  "pack.useBitmaps=false",
  "gc.auto=0",
  "maintenance.auto=false",
].flatMap((setting) => ["-c", setting]);

/**
 * A history repository's input path ("/workspace" or "/repos/<name>", CodingTaskInput.gitHistory)
 * as a local directory under `workspace` or `reposRoot`. Null for anything else.
 */
export function resolveHistoryPath(path, { workspace = "/workspace", reposRoot = "/repos" } = {}) {
  if (path === "/workspace") return workspace;
  if (typeof path !== "string" || !path.startsWith("/repos/")) return null;
  const name = path.slice("/repos/".length);
  if (!REPOSITORY_NAME.test(name) || name === "." || name === "..") return null;
  return join(reposRoot, name);
}

async function isRealDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A small regular file's text: null when it is missing, a symlink or anything but a regular file,
 * or larger than `maxBytes`. Opened without following a final symlink, and checked again once open.
 */
async function readSmallFile(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return null;
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Where a loose ref would be: "missing" when a directory on its path or the file itself does not
 * exist (the ref may be packed), "unsafe" when any of them is a symlink or the wrong kind of file.
 */
async function looseRefState(gitDir, refName) {
  const parts = refName.split("/");
  let path = gitDir;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let info;
    try {
      info = await lstat(path);
    } catch {
      return "missing";
    }
    const last = index === parts.length - 1;
    if (last ? !info.isFile() : !info.isDirectory()) return "unsafe";
  }
  return "present";
}

function validRefName(name) {
  return (
    REF_NAME.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.split("/").some((part) => part.startsWith("."))
  );
}

/**
 * Reads <gitDir>/HEAD and the ref it names (loose file, then packed-refs) as text. Never runs git.
 * Returns a 40-hex sha or null. Refuses (returns null) if HEAD, the ref file or packed-refs is a
 * symlink or larger than 64 KiB, or the ref name contains "..". A ref naming another ref is refused.
 */
export async function readHeadCommit(gitDir) {
  if (!(await isRealDirectory(gitDir))) return null;
  const headText = await readSmallFile(join(gitDir, "HEAD"), MAX_REF_FILE_BYTES);
  if (headText === null) return null;
  const head = headText.replace(/\n$/, "");
  if (COMMIT.test(head)) return head;
  if (!head.startsWith("ref: ")) return null;
  const refName = head.slice("ref: ".length);
  if (!validRefName(refName)) return null;

  const loose = await looseRefState(gitDir, refName);
  if (loose === "unsafe") return null;
  if (loose === "present") {
    const text = await readSmallFile(join(gitDir, refName), MAX_REF_FILE_BYTES);
    if (text === null) return null;
    const sha = text.replace(/\n$/, "");
    return COMMIT.test(sha) ? sha : null;
  }
  const packed = await readSmallFile(join(gitDir, "packed-refs"), MAX_REF_FILE_BYTES);
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space !== 40) continue;
    if (line.slice(41) === refName) {
      const sha = line.slice(0, 40);
      return COMMIT.test(sha) ? sha : null;
    }
  }
  return null;
}

/** The validated lines of <gitDir>/shallow: "" when there is none; throws when it is unsafe. */
async function validatedShallow(gitDir) {
  const path = join(gitDir, "shallow");
  try {
    await lstat(path);
  } catch {
    return "";
  }
  const text = await readSmallFile(path, MAX_SHALLOW_BYTES);
  if (text === null) throw new Error("result_bundle_shallow_invalid");
  const lines = text.split("\n").filter((line) => line !== "");
  if (!lines.every((line) => COMMIT.test(line))) throw new Error("result_bundle_shallow_invalid");
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Runs git in the scratch repository with no inherited environment beyond PATH: no user or system
 * config, HOME and cwd in the scratch directory. Resolves with { code, stdout }; stdout is bounded,
 * stderr is discarded (it never leaves this module), and `stdoutFd` sends stdout to a file instead.
 */
function runGit(gitBinary, scratch, args, { timeoutMs = STEP_TIMEOUT_MS, stdoutFd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gitBinary, [...SAFE_CONFIG, ...args], {
        cwd: scratch.root,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: scratch.home,
          GIT_DIR: scratch.gitDir,
          GIT_CEILING_DIRECTORIES: scratch.root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LANG: "C",
          LC_ALL: "C",
        },
        stdio: ["ignore", stdoutFd ?? "pipe", "pipe"],
      });
    } catch {
      resolve({ code: -1, stdout: "" });
      return;
    }
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 64 * 1024) stdout += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

/**
 * The scratch repository: our own HEAD, config and refs, and an object store whose only alternate is
 * a shadow directory of ours. The shadow links each of the agent's loose-object directories and its
 * pack directory, so git reads the agent's objects but never the agent's `objects/info` (its
 * alternates, commit-graph or packs list): nested alternates are stripped, not followed.
 */
async function createScratch(scratchRoot, agentObjects, shallow) {
  const root = await mkdtemp(join(scratchRoot, "wardby-result-bundle-"));
  const gitDir = join(root, "repo");
  const shadow = join(root, "objects");
  const home = join(root, "home");
  await mkdir(join(gitDir, "objects", "info"), { recursive: true });
  await mkdir(join(gitDir, "refs", "heads"), { recursive: true });
  await mkdir(join(shadow, "info"), { recursive: true });
  await mkdir(home);
  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    join(gitDir, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = true\n\thooksPath = /dev/null\n\tfsmonitor = false\n",
  );
  await writeFile(join(gitDir, "objects", "info", "alternates"), `${shadow}\n`);
  if (shallow) await writeFile(join(gitDir, "shallow"), shallow);
  await symlink(join(agentObjects, "pack"), join(shadow, "pack"));
  for (let byte = 0; byte < 256; byte += 1) {
    const name = byte.toString(16).padStart(2, "0");
    await symlink(join(agentObjects, name), join(shadow, name));
  }
  return { root, gitDir, home };
}

/**
 * Builds <repoPath>/.git/wardby-result.bundle of head --not baseCommit ...excludeCommits, or, when
 * HEAD is one of excludeCommits (a fast-forward onto a remote tip), of head --not baseCommit.
 * Uses a scratch repo in os.tmpdir() (or `scratchRoot`) with its own config and
 * objects/info/alternates reaching <repoPath>/.git/objects, and a validated copy of
 * <repoPath>/.git/shallow (lines of 40-hex only). Runs git with env GIT_CONFIG_NOSYSTEM=1,
 * GIT_CONFIG_GLOBAL=/dev/null, HOME=<scratch>, cwd=<scratch>, and -c core.hooksPath=/dev/null
 * -c core.fsmonitor=false. Returns { bundled: true, head } | { bundled: false, reason: "no_head" |
 * "no_new_commits" }. Removes any pre-existing bundle file first. Throws only fixed
 * `result_bundle_*` codes, never git's output.
 */
export async function createResultBundle({
  repoPath,
  baseCommit,
  excludeCommits,
  gitBinary = "git",
  scratchRoot = tmpdir(),
  timeoutMs = BUNDLE_TIMEOUT_MS,
}) {
  const gitDir = join(repoPath, ".git");
  // Never delete or write through a .git that is a symlink (or anything but a directory).
  if (!(await isRealDirectory(gitDir))) return { bundled: false, reason: "no_head" };
  // First of all, so that no failure below ever leaves a bundle the agent planted.
  const bundlePath = join(gitDir, RESULT_BUNDLE_NAME);
  try {
    await rm(bundlePath, { force: true, recursive: true });
    await rm(`${bundlePath}.lock`, { force: true, recursive: true });
  } catch {
    throw new Error("result_bundle_write_failed");
  }
  try {
    return await bundleInto(bundlePath, gitDir, { baseCommit, excludeCommits, gitBinary, scratchRoot, timeoutMs });
  } catch (error) {
    await rm(bundlePath, { force: true }).catch(() => undefined);
    throw error instanceof Error && /^result_bundle_[a-z_]+$/.test(error.message)
      ? error
      : new Error("result_bundle_failed");
  }
}

async function bundleInto(bundlePath, gitDir, { baseCommit, excludeCommits, gitBinary, scratchRoot, timeoutMs }) {
  if (
    typeof baseCommit !== "string" ||
    !COMMIT.test(baseCommit) ||
    !Array.isArray(excludeCommits) ||
    !excludeCommits.every((commit) => typeof commit === "string" && COMMIT.test(commit))
  ) {
    throw new Error("result_bundle_input_invalid");
  }
  const head = await readHeadCommit(gitDir);
  if (head === null) return { bundled: false, reason: "no_head" };
  if (head === baseCommit) return { bundled: false, reason: "no_new_commits" };
  const agentObjects = join(gitDir, "objects");
  if (!(await isRealDirectory(agentObjects))) return { bundled: false, reason: "no_head" };
  const shallow = await validatedShallow(gitDir);

  let scratch;
  try {
    scratch = await createScratch(scratchRoot, agentObjects, shallow);
  } catch {
    throw new Error("result_bundle_scratch_failed");
  }
  try {
    const step = { timeoutMs: Math.min(STEP_TIMEOUT_MS, timeoutMs) };
    const exists = await runGit(gitBinary, scratch, ["cat-file", "-e", `${head}^{commit}`], step);
    if (exists.code !== 0) return { bundled: false, reason: "no_head" };
    let excluded = ["--not", baseCommit, ...excludeCommits];
    const counted = await runGit(gitBinary, scratch, ["rev-list", "--count", head, ...excluded], step);
    if (counted.code !== 0) throw new Error("result_bundle_git_failed");
    if (counted.stdout.trim() === "0") {
      // A fast-forward onto a remote tip (a fork sync with nothing to merge): HEAD is the tip itself.
      // It is bundled against the base alone, and the control plane pushes the tip unchanged.
      if (!excludeCommits.includes(head)) return { bundled: false, reason: "no_new_commits" };
      excluded = ["--not", baseCommit];
      const ahead = await runGit(gitBinary, scratch, ["rev-list", "--count", head, ...excluded], step);
      if (ahead.code !== 0) throw new Error("result_bundle_git_failed");
      if (ahead.stdout.trim() === "0") return { bundled: false, reason: "no_new_commits" };
    }
    const updated = await runGit(gitBinary, scratch, ["update-ref", BUNDLE_HEAD_REF, head], step);
    if (updated.code !== 0) throw new Error("result_bundle_git_failed");

    // Streamed to a file created here (never through an existing file or symlink), not by git.
    let output;
    try {
      output = await open(bundlePath, CREATE_FLAGS, 0o644);
    } catch {
      throw new Error("result_bundle_write_failed");
    }
    let created;
    try {
      created = await runGit(gitBinary, scratch, ["bundle", "create", "-", BUNDLE_HEAD_REF, ...excluded], {
        timeoutMs,
        stdoutFd: output.fd,
      });
    } finally {
      await output.close().catch(() => undefined);
    }
    if (created.code !== 0) throw new Error("result_bundle_git_failed");
    return { bundled: true, head };
  } finally {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** True when `git --version` exits 0. */
export async function gitAvailable(gitBinary = "git") {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gitBinary, ["--version"], {
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", LANG: "C" },
        stdio: "ignore",
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), VERSION_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
