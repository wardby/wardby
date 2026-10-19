import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatRefusals, recentRefusals, registryAccess } from "../coding-worker/registry-refusals.mjs";

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_TIMEOUT_MS = 120_000;
/** After a timeout's SIGTERM, how long the command's process group has before SIGKILL. */
export const KILL_GRACE_MS = 2_000;
/** The launcher's setup for this run (src/providers/jobs/claude-tool-setup.ts). */
export const TOOL_SETUP_ENV = "WARDBY_TOOL_SETUP";
/** The npm shim (src/coding-worker/npm-shim.mjs), ahead of the real npm. */
export const SHIM_DIRECTORY = "/opt/wardby/bin";

const RESERVED_NAMES = new Set(["HOME", "LANG", "PATH", "TMPDIR", TOOL_SETUP_ENV]);
/** Workspace-relative cache root: registry config files (parseToolSetup) and the
 *  agent's temporary files (TMPDIR, below) both live here, so both stay out of
 *  the collected workspace via the ".cache" entry in collect-exclude.ts. */
const CACHE_DIRNAME = ".cache";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/**
 * Setup bounds; claude-tool-setup.ts builds within exactly these. Entries cover the registry's
 * variables plus every service test variable a run can carry (16 services x 32). The whole setup
 * travels as one environment variable, which Linux caps at 128 KiB.
 */
export const MAX_ENV_ENTRIES = 1024;
export const MAX_ENV_VALUE_BYTES = 4096;
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_SETUP_BYTES = 96 * 1024;
const FILE_MODES = new Set([0o600, 0o644]);
const EMPTY_SETUP = Object.freeze({ env: Object.freeze({}), files: Object.freeze([]) });

function cacheRootFor(workspacePath) {
  return `${workspacePath}/${CACHE_DIRNAME}`;
}

/** Where a command's TMPDIR points: workspace disk, not the tiny `/tmp` tmpfs
 *  (docker-isolation.ts's scratchMb caps it at 64 MiB, too small for a real
 *  `pip install` or `npm install` to unpack and build in). */
function cacheTmpDirFor(workspacePath) {
  return `${cacheRootFor(workspacePath)}/tmp`;
}

export function toolEnvironment(workspacePath = "/workspace") {
  return {
    HOME: "/home/wardby",
    LANG: "C.UTF-8",
    PATH: `${SHIM_DIRECTORY}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: cacheTmpDirFor(workspacePath),
  };
}

/**
 * The launcher's setup: registry settings and service test variables for every command, and the
 * registry's config files under the workspace's .cache. Trusted input, still checked: anything
 * unexpected stops the tool runner before it reports ready, rather than running half-configured.
 */
export function parseToolSetup(raw, workspacePath = "/workspace") {
  if (raw === undefined || raw === "") return EMPTY_SETUP;
  const invalid = () => new Error("tool_setup_invalid");
  if (Buffer.byteLength(raw) > MAX_SETUP_BYTES) throw invalid();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw invalid();
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) throw invalid();
  const entries = Object.entries(value.env);
  if (entries.length > MAX_ENV_ENTRIES) throw invalid();
  const env = {};
  for (const [name, text] of entries) {
    if (!ENV_NAME.test(name) || RESERVED_NAMES.has(name)) throw invalid();
    if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text) > MAX_ENV_VALUE_BYTES)
      throw invalid();
    env[name] = text;
  }
  // Set by the launcher only on a dependency-cache run (claude-tool-setup.ts); main.mjs then offers
  // the worker its one prepare call. An older tool runner ignores the key.
  if (value.dependencyCache !== undefined && typeof value.dependencyCache !== "boolean") throw invalid();
  // The workspace volume size (MiB) the dependency cache must stay inside; only with the flag.
  if (value.diskMb !== undefined) {
    if (value.dependencyCache !== true) throw invalid();
    if (!Number.isSafeInteger(value.diskMb) || value.diskMb < 64 || value.diskMb > 32_768) throw invalid();
  }
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) throw invalid();
  const cacheRoot = `${cacheRootFor(workspacePath)}/`;
  const files = value.files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw invalid();
    if (!file.path.startsWith(cacheRoot) || file.path.split("/").includes("..")) throw invalid();
    if (!FILE_MODES.has(file.mode) || Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw invalid();
    return { path: file.path, content: file.content, mode: file.mode };
  });
  return Object.freeze({
    env: Object.freeze(env),
    files: Object.freeze(files),
    ...(value.dependencyCache === true ? { dependencyCache: true } : {}),
    ...(value.diskMb !== undefined ? { diskMb: value.diskMb } : {}),
  });
}

/** Exactly what a command's shell gets (runCommand); the dependency cache's npm runs with it too. */
export function commandEnvironment(setup = EMPTY_SETUP, workspacePath = "/workspace") {
  return { ...setup.env, ...toolEnvironment(workspacePath) };
}

/** What runCommand does to the workspace before each command: the setup files and TMPDIR. */
export async function prepareCommandWorkspace(setup = EMPTY_SETUP, workspacePath = "/workspace") {
  await applySetupFiles(setup);
  await ensureTmpDir(workspacePath);
}

/**
 * Rewritten before every command: the workspace is seeded after the tool runner starts, and a
 * command may delete its own .cache. Best effort: a file that can't be written leaves the package
 * manager unauthenticated, which the registry reports on its own.
 */
async function applySetupFiles(setup) {
  for (const file of setup.files) {
    try {
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
      await rm(file.path, { force: true });
      await writeFile(file.path, file.content, { mode: file.mode, flag: "wx" });
    } catch {
      // See above.
    }
  }
}

/**
 * Rewritten before every command, like applySetupFiles above: a command may delete its own
 * .cache (including TMPDIR), and a package manager needs the directory to already exist.
 */
async function ensureTmpDir(workspacePath) {
  try {
    await mkdir(cacheTmpDirFor(workspacePath), { recursive: true, mode: 0o700 });
  } catch {
    // Best effort: a command that can't create its own TMPDIR fails loudly on its own.
  }
}

/** How far before a command's start a refusal still counts as its own (the proxy's clock may lag). */
const REFUSAL_CLOCK_SLACK_MS = 2_000;

/**
 * A failed command's output, plus a line for each package the registry refused
 * while it ran: pip and uv don't print why (npm does, so its lines repeat what
 * it said). Bounded by the lookup's own timeout; never throws.
 */
export async function withPackageRefusals(result, env, startedAt, lookup = recentRefusals) {
  if (result.code === 0) return result;
  const lines = formatRefusals(await lookup(registryAccess(env), new Date(startedAt - REFUSAL_CLOCK_SLACK_MS)));
  return lines.length > 0 ? { ...result, output: `${result.output}\n${lines.join("\n")}\n` } : result;
}

export async function runCommand(command, timeoutMs, workspacePath = "/workspace", setup = EMPTY_SETUP) {
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error("tool_command_too_large");
  const timeout = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, timeoutMs));
  await prepareCommandWorkspace(setup, workspacePath);
  const env = commandEnvironment(setup, workspacePath);
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: workspacePath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout reaches grandchildren that still hold the pipes.
      detached: true,
    });
    const chunks = [];
    let size = 0;
    let timedOut = false;
    const append = (chunk) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      const bounded = Buffer.from(chunk).subarray(0, MAX_OUTPUT_BYTES - size);
      chunks.push(bounded);
      size += bounded.byteLength;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS).unref();
    }, timeout);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output: Buffer.concat(chunks).toString("utf8") });
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, output: "tool execution failed" });
    });
  });
  return withPackageRefusals(result, env, startedAt);
}

function signalGroup(pid, signal) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}
