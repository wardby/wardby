/**
 * The workspace steps a bridge that holds the run's workspace takes: fetch its setup, extract the
 * seed, end a child's process group, and tar and upload the workspace. The tool bridge (pair runs)
 * and the Codex bridge (one-actor runs) share them.
 *
 * Extra repositories (multi-repository runs): the setup lists them (`repositories`: names and access
 * only). Each one's seed is extracted after the `/workspace` seed into `/repos/<name>`, and a read one
 * is then made read-only (directories 0555, files 0444) so ordinary writes fail; that is a courtesy,
 * not the boundary: the proxy never accepts a read repository's upload and the launcher never reads
 * one. Each writable one is uploaded to `repos/<name>/workspace` before `/workspace`, whose upload
 * writes `done`; an extra's failure is logged and fails only that repository, never the run.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * Nothing secret is logged (see Logger in common.ts); a setup body is never logged.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants, readdirSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { postCapped, stderrLogger, uploadFile, withRound, type Logger } from "./common.js";
import { MAX_SETUP_REPOSITORIES, REPOSITORY_NAME, RESULT_BUNDLE_FILE } from "./constants.js";
import { BridgeError, send, withRetry, type RetryPolicy } from "./http.js";
import { checkTarFile, tarExcludeArgs, type CollectExclusions } from "./tar.js";

const REQUEST_TIMEOUT_MS = 30_000;

/** The part of a child process the group signalling needs (a seam for tests). */
export interface GroupSignalTarget {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/**
 * Signals a child's process group. ESRCH means nothing is left in the group; EPERM falls back to
 * the child process alone; anything else is logged as a fixed-field event, never thrown. A SIGKILL
 * after the child already exited is skipped once the group is gone, so a recycled pid is never hit.
 */
export function signalGroup(
  child: GroupSignalTarget,
  signal: NodeJS.Signals,
  killFn: (pid: number, signal: NodeJS.Signals | 0) => unknown = (pid, sig) => process.kill(pid, sig),
  log: Logger = stderrLogger,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const runnerExited = child.exitCode !== null || child.signalCode !== null;
  if (signal === "SIGKILL" && runnerExited) {
    try {
      killFn(-pid, 0);
    } catch (err) {
      if (errnoOf(err) === "ESRCH") return;
    }
  }
  try {
    killFn(-pid, signal);
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ESRCH") return;
    if (code === "EPERM") {
      try {
        child.kill(signal);
      } catch {
        // The runner itself is gone or not ours; nothing more to signal.
      }
      return;
    }
    log("substrate_bridge_runner_signal_failed", { signal, errno: code ?? "unknown" });
  }
}

/** One process as /proc/<pid>/stat shows it. */
export interface ProcEntry {
  pid: number;
  /** Its process group. */
  pgid: number;
  /** The one-letter state: `Z` is a zombie (exited, not yet reaped: it can no longer run or write). */
  state: string;
}

/** The pid, state and process group of a /proc/<pid>/stat line, or undefined when it cannot be read. */
export function parseProcStat(text: string): ProcEntry | undefined {
  // "<pid> (<comm>) <state> <ppid> <pgrp> ...": comm may hold spaces and parentheses, so the fields
  // after it are read from the last ")".
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close < open) return undefined;
  const pid = Number(text.slice(0, open));
  const [state, , pgrp] = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const pgid = Number(pgrp);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid) || state === undefined || state === "")
    return undefined;
  return { pid, pgid, state };
}

/** Every process /proc shows, or undefined when there is no /proc to read (not Linux). */
export function readProcTable(root = "/proc"): ProcEntry[] | undefined {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return undefined;
  }
  const entries: ProcEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const entry = parseProcStat(readFileSync(join(root, name, "stat"), "utf8"));
      if (entry) entries.push(entry);
    } catch {
      // Gone since the listing.
    }
  }
  return entries;
}

/** What `endGroup` uses to signal and look at processes (a seam for tests). */
export interface ProcessSeams {
  kill: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  /** The process table, or undefined when it cannot be read (then liveness falls back to kill 0). */
  procs: () => ProcEntry[] | undefined;
  /** Whether this bridge is the actor's PID 1 (only then is everything else swept). */
  isInit: () => boolean;
  selfPid: number;
}

const defaultSeams = (): ProcessSeams => ({
  kill: (pid, signal) => process.kill(pid, signal),
  procs: () => readProcTable(),
  isInit: () => process.pid === 1,
  selfPid: process.pid,
});

/**
 * Whether anything of ours that can still run is left in the child's process group. With /proc, a
 * member counts only when it is not a zombie: as PID 1 the bridge is the parent of every orphan, and
 * Node reaps only the children it spawned itself, so an orphan that exited stays a zombie (harmless:
 * it can neither run nor write, and the actor ends with the run). Without /proc: kill(-pgid, 0),
 * false once ESRCH or EPERM.
 */
function groupAlive(child: GroupSignalTarget, seams: ProcessSeams): boolean {
  const pgid = child.pid;
  if (pgid === undefined) return false;
  const table = seams.procs();
  if (table) return table.some((entry) => entry.pgid === pgid && entry.state !== "Z");
  try {
    seams.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = errnoOf(err);
    return code !== "ESRCH" && code !== "EPERM";
  }
}

/** Whether any process but this bridge that can still run is left (false without /proc). */
function othersAlive(seams: ProcessSeams): boolean {
  return (seams.procs() ?? []).some((entry) => entry.pid !== seams.selfPid && entry.state !== "Z");
}

const GROUP_POLL_MS = 20;
/** How long after a SIGKILL its processes are waited for (they go at once; this only bounds a stuck one). */
const GROUP_KILL_WAIT_MS = 2_000;

async function waitUntil(gone: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (gone()) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
}

/**
 * Ends a child and every process it started: SIGTERM to its process group, up to `graceMs` for the
 * group to go, then SIGKILL to whatever is left, and a bounded wait for it to be gone. Then, only
 * when this bridge is the actor's PID 1, a sweep: kill(-1, SIGKILL) reaches every process this bridge
 * may signal but itself (POSIX), so a tool process that left the group (setsid/setpgid) cannot change
 * the workspace while it is read either. Every process in the actor runs as the bridge's uid, and the
 * actor holds nothing else that must survive (the bridge starts tar only after this). Never on a dev
 * host or in tests, where -1 would reach the user's other processes.
 */
export async function endGroup(
  child: GroupSignalTarget,
  graceMs: number,
  log: Logger,
  seams: ProcessSeams = defaultSeams(),
): Promise<void> {
  if (child.pid !== undefined) {
    signalGroup(child, "SIGTERM", seams.kill, log);
    if (!(await waitUntil(() => !groupAlive(child, seams), graceMs))) {
      signalGroup(child, "SIGKILL", seams.kill, log);
      if (!(await waitUntil(() => !groupAlive(child, seams), GROUP_KILL_WAIT_MS)))
        log("substrate_bridge_group_still_running");
    }
  }
  if (!seams.isInit()) return;
  try {
    seams.kill(-1, "SIGKILL");
  } catch (err) {
    // ESRCH: nothing else was left.
    if (errnoOf(err) !== "ESRCH") log("substrate_bridge_sweep_failed", { errno: errnoOf(err) ?? "unknown" });
    return;
  }
  if (!(await waitUntil(() => !othersAlive(seams), GROUP_KILL_WAIT_MS))) log("substrate_bridge_sweep_still_running");
}

/**
 * Runs a subprocess to completion with no shell; resolves with its exit code once its stderr ended.
 * Its stderr is passed on to the bridge's.
 */
export const exec = (command: string, args: string[]): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
  });

/**
 * The run's setup file (GET tool-setup), with the standard retry rules until `deadlineMs`. Throws
 * BridgeError("substrate_bridge_setup_failed") for any answer but 200 and for retries that ran out;
 * any other BridgeError (substrate_bridge_stopped) is passed on. The body is never logged.
 */
export async function fetchSetup(
  url: string,
  headers: Record<string, string>,
  policy: RetryPolicy,
  log: Logger,
  deadlineMs: number,
): Promise<Buffer> {
  void log;
  let result;
  try {
    result = await withRetry(() => send(url, { method: "GET", headers, timeoutMs: REQUEST_TIMEOUT_MS }), {
      policy,
      deadlineMs,
    });
  } catch (error) {
    if (error instanceof BridgeError && error.code !== "substrate_bridge_retry_exhausted") throw error;
    throw new BridgeError("substrate_bridge_setup_failed");
  }
  if (result.status !== 200) throw new BridgeError("substrate_bridge_setup_failed");
  return result.body;
}

/** How long a seed download may take, and how long it keeps being retried. */
const SEED_TIMEOUT_MS = 10 * 60_000;
const SEED_DEADLINE_MS = 5 * 60_000;

/**
 * Downloads the run's seed into `stage`, checks it (tar.ts) and extracts it into `workspace`; resolves
 * with the checked entry count. Throws
 * BridgeError("substrate_bridge_seed_failed") or ("substrate_bridge_seed_unsafe"); any other
 * BridgeError (substrate_bridge_stopped) is passed on. The staged seed is always removed.
 */
export async function extractSeed(o: {
  url: string;
  headers: Record<string, string>;
  workspace: string;
  stage: string;
  tar: string;
  policy: RetryPolicy;
  log: Logger;
  /** An extra repository's validated name: added to the unsafe-seed log line (never a path). */
  repository?: string;
}): Promise<{ entries: number }> {
  const seedPath = join(o.stage, "seed.tar");
  try {
    const seed = await withRetry(
      () => send(o.url, { method: "GET", headers: o.headers, downloadTo: seedPath, timeoutMs: SEED_TIMEOUT_MS }),
      { policy: o.policy, deadlineMs: SEED_DEADLINE_MS },
    );
    if (seed.status !== 200) throw new BridgeError("substrate_bridge_seed_failed");
    const checked = await checkTarFile(seedPath, true);
    if (!checked.ok) {
      o.log("substrate_bridge_seed_unsafe", {
        reason: checked.reason,
        ...(o.repository === undefined ? {} : { repository: o.repository }),
      });
      throw new BridgeError("substrate_bridge_seed_unsafe");
    }
    await mkdir(o.workspace, { recursive: true });
    const code = await exec(o.tar, [
      "-x",
      "-C",
      o.workspace,
      "-f",
      seedPath,
      "--no-same-owner",
      "--delay-directory-restore",
      // /workspace is a root-owned mount point the bridge (uid 10001) cannot chmod or utime, so the
      // seed's "." entry must not be applied to it: drop the leading "./" (tar.ts refuses any seed whose
      // entries are not under "./"). Existing directories keep their metadata.
      "--strip-components=1",
      "--no-overwrite-dir",
    ]);
    if (code !== 0) throw new BridgeError("substrate_bridge_seed_failed");
    o.log("substrate_bridge_seed_extracted", { entries: checked.entries });
    return { entries: checked.entries };
  } catch (error) {
    if (error instanceof BridgeError && error.code !== "substrate_bridge_retry_exhausted") throw error;
    throw new BridgeError("substrate_bridge_seed_failed");
  } finally {
    await rm(seedPath, { force: true }).catch(() => undefined);
  }
}

/** One extra repository of the run's setup (providers/jobs/codex-worker-setup.ts HolderSetupRepository). */
export interface SetupRepository {
  name: string;
  access: "read" | "write";
  /** A git-history write extra: its upload carries only its `.git`'s result bundle. */
  collectResultBundle: boolean;
}

const SETUP_REPOSITORY_KEYS: ReadonlySet<string> = new Set(["name", "access", "collectResultBundle"]);

/**
 * The setup's `repositories`, read strictly. Absent → []; a valid list → it; anything else → undefined
 * (the caller fails the run with substrate_bridge_setup_invalid). A valid list is an array of at most
 * MAX_SETUP_REPOSITORIES objects with keys within name, access and collectResultBundle; a link name
 * (not `workspace`) at most once; access `read` or `write`; collectResultBundle absent or true, and true
 * only on a write entry.
 */
export function parseSetupRepositories(value: unknown): SetupRepository[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SETUP_REPOSITORIES) return undefined;
  const seen = new Set<string>();
  const repositories: SetupRepository[] = [];
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !SETUP_REPOSITORY_KEYS.has(key))) return undefined;
    const { name, access, collectResultBundle } = fields;
    if (typeof name !== "string" || !REPOSITORY_NAME.test(name) || name === "workspace" || seen.has(name))
      return undefined;
    if (access !== "read" && access !== "write") return undefined;
    if (collectResultBundle !== undefined && collectResultBundle !== true) return undefined;
    if (collectResultBundle === true && access !== "write") return undefined;
    seen.add(name);
    repositories.push({ name, access, collectResultBundle: collectResultBundle === true });
  }
  return repositories;
}

/**
 * Makes everything under `root` (and `root` itself) read-only: directories and files with any execute
 * bit 0555, other files 0444 (as Docker and Kubernetes read-only mounts keep a script runnable; the
 * explicit mode also clears setuid, setgid and sticky), children before their directory. Symlinks are left alone (lstat: never followed, so nothing outside the tree
 * is touched). The whole tree is listed first; past `maxEntries` entries (the root counts) it throws
 * BridgeError("substrate_bridge_seed_failed") before anything is changed.
 */
export async function makeReadOnly(root: string, maxEntries: number): Promise<void> {
  const entries: { path: string; mode: number | undefined }[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (entries.length >= maxEntries) throw new BridgeError("substrate_bridge_seed_failed");
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      entries.push({ path, mode: undefined });
    } else if (metadata.isDirectory()) {
      entries.push({ path, mode: 0o555 });
      for (const name of await readdir(path)) pending.push(join(path, name));
    } else {
      entries.push({ path, mode: metadata.mode & 0o111 ? 0o555 : 0o444 });
    }
  }
  // Every directory was listed before its children: change them in reverse, so a directory goes last.
  for (let i = entries.length - 1; i >= 0; i--) {
    const { path, mode } = entries[i];
    if (mode !== undefined) await chmod(path, mode);
  }
}

/** An extra repository's folder as the bridge seeded it (lstat dev/ino), checked again before collect. */
export type RepositoryFolder = { dev: number; ino: number };

/** Each seeded extra's folder identity, by repository name. */
export type RepositoryFolders = ReadonlyMap<string, RepositoryFolder>;

/** Whether `path` is still the real directory `folder` recorded (lstat: a symlink never matches). */
async function isSameFolder(path: string, folder: RepositoryFolder): Promise<boolean> {
  const metadata = await lstat(path).catch(() => undefined);
  return !!metadata?.isDirectory() && metadata.dev === folder.dev && metadata.ino === folder.ino;
}

/** The run token of a bridge's `<proxy>/substrate/runs/<token>` base. */
const runTokenOf = (base: string): string => base.slice(base.lastIndexOf("/") + 1);

/**
 * Each extra repository's seed (GET repos/<name>/seed) into `<reposRoot>/<name>`, in setup order, with
 * extractSeed (the same checks and tar flags as the `/workspace` seed); a read one is then made
 * read-only. Returns each folder's identity (lstat dev/ino, a real directory), which collectRepositories
 * re-checks: `/repos/<name>` is a plain directory, not a mount point, so a tool process could swap it.
 * Throws extractSeed's codes, or substrate_bridge_seed_failed when the read-only walk fails or the folder
 * is not a real directory.
 */
export async function extractRepositorySeeds(o: {
  base: string;
  headers: Record<string, string>;
  reposRoot: string;
  repositories: readonly SetupRepository[];
  stage: string;
  tar: string;
  policy: RetryPolicy;
  log: Logger;
}): Promise<Map<string, RepositoryFolder>> {
  const token = runTokenOf(o.base);
  const folders = new Map<string, RepositoryFolder>();
  // extractSeed's own "extracted" line would carry no repository: this function logs its own.
  const log: Logger = (event, fields) => {
    if (event !== "substrate_bridge_seed_extracted") o.log(event, fields);
  };
  for (const { name, access } of o.repositories) {
    const workspace = join(o.reposRoot, name);
    const { entries } = await extractSeed({
      url: `${o.base}/repos/${name}/seed`,
      headers: o.headers,
      workspace,
      stage: o.stage,
      tar: o.tar,
      policy: o.policy,
      log,
      repository: name,
    });
    if (access === "read") {
      try {
        await makeReadOnly(workspace, entries + 1);
      } catch {
        throw new BridgeError("substrate_bridge_seed_failed");
      }
    }
    const metadata = await lstat(workspace).catch(() => undefined);
    if (!metadata?.isDirectory()) throw new BridgeError("substrate_bridge_seed_failed");
    folders.set(name, { dev: metadata.dev, ino: metadata.ino });
    o.log("substrate_bridge_repository_seed_extracted", { runToken: token, repository: name, entries });
  }
  return folders;
}

/**
 * Each write extra's `<reposRoot>/<name>`, in setup order, with collectWorkspace (uploaded to
 * `repos/<name>/workspace`, a failure logged only). Read extras are never uploaded. Call it before the
 * `/workspace` collect, whose upload writes `done` (the proxy refuses an extra's upload after it).
 * Each folder must still be the directory extractRepositorySeeds recorded (`folders`), before the tar and
 * again before the upload; otherwise that repository fails with code `repository_changed` and nothing
 * under it is read further.
 */
export async function collectRepositories(o: {
  base: string;
  round: number;
  token: string;
  headers: Record<string, string>;
  reposRoot: string;
  repositories: readonly SetupRepository[];
  folders: RepositoryFolders;
  stage: string;
  tar: string;
  exclusions: CollectExclusions;
  beforeResultBundleRecheck?: () => Promise<void> | void;
  policy: RetryPolicy;
  log: Logger;
  signal: AbortSignal;
}): Promise<void> {
  for (const { name, access, collectResultBundle } of o.repositories) {
    if (access !== "write") continue;
    const folder = o.folders.get(name);
    if (!folder) {
      // Never seeded by this bridge: nothing to compare against, so it is not read.
      o.log("substrate_bridge_collect_failed", { runToken: o.token, repository: name, code: REPOSITORY_CHANGED });
      continue;
    }
    await collectWorkspace({
      base: o.base,
      round: o.round,
      token: o.token,
      headers: o.headers,
      workspace: join(o.reposRoot, name),
      stage: o.stage,
      tar: o.tar,
      exclusions: o.exclusions,
      collectResultBundle,
      beforeResultBundleRecheck: o.beforeResultBundleRecheck,
      policy: o.policy,
      log: o.log,
      signal: o.signal,
      uploadPath: `repos/${name}/workspace`,
      onFailure: "log",
      repository: name,
      folder,
    }).catch((): "failed" => {
      // Whatever went wrong fails this repository only: the /workspace collect still follows.
      o.log("substrate_bridge_collect_failed", { runToken: o.token, repository: name, code: "unexpected" });
      return "failed";
    });
  }
}

/** Why a git-history run's upload carries no result bundle (a fixed value, logged as is). */
type BundleSkip =
  "git_not_directory" | "absent" | "bundle_symlink" | "not_regular_file" | "git_changed" | "short_read" | "copy_failed";

/**
 * The skips that mean something changed the workspace's `.git` or the bundle under the bridge: the run
 * fails (workspace-failed) instead of carrying on without the agent's commits. A missing `.git` or
 * bundle is not one of them: it is the same outcome as on Docker and Kubernetes.
 */
const TAMPERING_SKIPS: ReadonlySet<BundleSkip> = new Set([
  "git_not_directory",
  "bundle_symlink",
  "not_regular_file",
  "git_changed",
]);

/** The collect code for a tampering skip (no real exit status of tar or the shell). */
const TAMPERED_CODE = -1;

/** An extra's collect code when its folder is no longer the directory the bridge seeded. */
const REPOSITORY_CHANGED = "repository_changed";

const BUNDLE_COPY_CHUNK = 1024 * 1024;

/**
 * Copies the workspace's result bundle into `staging/.git/` through one file descriptor, so what is
 * uploaded is a file the bridge read itself, never a path a tool process could still swap: `.git`
 * must be a real directory (lstat), the bundle is opened without following a symlink and without
 * blocking (a FIFO), must be a regular file, and `.git` must still be the same
 * directory (dev/ino) afterwards. Only the size fstat reported is copied. Returns the reason when
 * there is no bundle; nothing it reads is logged.
 */
async function stageResultBundle(
  workspace: string,
  staging: string,
  beforeRecheck?: () => Promise<void> | void,
): Promise<BundleSkip | undefined> {
  const gitPath = join(workspace, ".git");
  const git = await lstat(gitPath).catch(() => undefined);
  if (!git) return "absent";
  if (!git.isDirectory()) return "git_not_directory";
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let openError: unknown;
  const source = await open(join(gitPath, RESULT_BUNDLE_FILE), flags).catch((error: unknown) => {
    openError = error;
    return undefined;
  });
  // O_NOFOLLOW on a symlinked bundle fails with ELOOP: something replaced the agent's bundle.
  if (!source) return (openError as NodeJS.ErrnoException | undefined)?.code === "ELOOP" ? "bundle_symlink" : "absent";
  try {
    const metadata = await source.stat();
    if (!metadata.isFile()) return "not_regular_file";
    await beforeRecheck?.();
    const again = await lstat(gitPath).catch(() => undefined);
    if (!again?.isDirectory() || again.dev !== git.dev || again.ino !== git.ino) return "git_changed";
    try {
      await mkdir(join(staging, ".git"), { mode: 0o700 });
      const target = await open(join(staging, ".git", RESULT_BUNDLE_FILE), "wx", 0o600);
      try {
        const buffer = Buffer.alloc(Math.min(BUNDLE_COPY_CHUNK, Math.max(metadata.size, 1)));
        let copied = 0;
        while (copied < metadata.size) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, metadata.size - copied), copied);
          if (bytesRead === 0) return "short_read";
          await target.write(buffer, 0, bytesRead);
          copied += bytesRead;
        }
      } finally {
        await target.close();
      }
    } catch {
      return "copy_failed";
    }
    return undefined;
  } finally {
    await source.close();
  }
}

/**
 * Tars the workspace (without `exclusions`) and uploads it to `uploadPath`; on a tar that could not be
 * made, or an upload that could not be stored, posts workspace-failed so the launcher does not wait for
 * it. With `onFailure: "log"` (an extra repository) it posts nothing else: it logs
 * substrate_bridge_collect_failed with the repository and a fixed code, and only that repository fails.
 *
 * A git-history run (`collectResultBundle`) leaves the root .git out, then adds back only its result
 * bundle, copied through one file descriptor into a private staging folder (stageResultBundle). The
 * caller must already have ended every process that could change the workspace.
 */
export async function collectWorkspace(o: {
  base: string;
  round: number;
  token: string;
  headers: Record<string, string>;
  workspace: string;
  stage: string;
  tar: string;
  exclusions: CollectExclusions;
  collectResultBundle: boolean;
  beforeResultBundleRecheck?: () => Promise<void> | void;
  policy: RetryPolicy;
  log: Logger;
  signal: AbortSignal;
  /** Where the tar goes under the run's routes (default `workspace`). */
  uploadPath?: string;
  /** `log`: an extra repository's failure is logged only (default: post workspace-failed). */
  onFailure?: "workspace-failed" | "log";
  /** The extra repository's name, for the `log` mode's lines. */
  repository?: string;
  /** An extra's seeded folder: re-checked before the tar and before the upload (see collectRepositories). */
  folder?: RepositoryFolder;
}): Promise<"ok" | "rejected" | "failed"> {
  const { base, round, token, headers, workspace, stage, tar, exclusions, collectResultBundle, policy, log } = o;
  const uploadPath = o.uploadPath ?? "workspace";
  const logOnly = o.onFailure === "log";
  const tarPath = join(stage, "workspace.tar");
  const failExtra = (code: string | number): void =>
    log("substrate_bridge_collect_failed", { runToken: token, repository: o.repository ?? "", code });
  const folderChanged = async (): Promise<boolean> =>
    o.folder !== undefined && !(await isSameFolder(workspace, o.folder));
  if (await folderChanged()) {
    failExtra(REPOSITORY_CHANGED);
    return "failed";
  }
  const createExclusions = collectResultBundle
    ? { names: exclusions.names, paths: [...exclusions.paths, ".git"] }
    : exclusions;
  let code = await exec(tar, ["-c", "-C", workspace, ...tarExcludeArgs(createExclusions), "-f", tarPath, "."]);
  if ((code === 0 || code === 1) && collectResultBundle) {
    const bundleStage = await mkdtemp(join(stage, "bundle-"));
    try {
      const skipped = await stageResultBundle(workspace, bundleStage, o.beforeResultBundleRecheck);
      if (skipped) {
        log("substrate_bridge_result_bundle_skipped", {
          runToken: token,
          round,
          reason: skipped,
          ...(o.repository ? { repository: o.repository } : {}),
        });
        if (TAMPERING_SKIPS.has(skipped)) code = TAMPERED_CODE;
      } else {
        const appended = await exec(tar, [
          "-r",
          "-f",
          tarPath,
          "-C",
          bundleStage,
          "--no-recursion",
          `./.git/${RESULT_BUNDLE_FILE}`,
        ]);
        if (appended !== 0 && appended !== 1) code = appended;
      }
    } finally {
      await rm(bundleStage, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  // 1: some files changed while being read; the tar is still usable.
  if (code !== 0 && code !== 1) {
    const failure = code === TAMPERED_CODE ? "result_bundle_tampered" : code;
    await rm(tarPath, { force: true }).catch(() => undefined);
    if (logOnly) {
      failExtra(failure);
      return "failed";
    }
    log("substrate_bridge_collect_failed", { code: failure });
    await postCapped(
      withRound(`${base}/workspace-failed`, round),
      headers,
      undefined,
      policy,
      log,
      "workspace-failed",
      o.signal,
    );
    return "failed";
  }
  // Swapped while it was read (a symlink or another folder in its place): the tar is not the seeded folder.
  if (await folderChanged()) {
    await rm(tarPath, { force: true }).catch(() => undefined);
    failExtra(REPOSITORY_CHANGED);
    return "failed";
  }
  const outcome = await uploadFile(
    withRound(`${base}/${uploadPath}`, round),
    headers,
    tarPath,
    policy,
    log,
    logOnly ? "repos.workspace" : "workspace",
    o.signal,
  );
  await rm(tarPath, { force: true }).catch(() => undefined);
  if (logOnly) {
    if (outcome !== "ok") failExtra(`upload_${outcome}`);
    return outcome === "ok" ? "ok" : outcome === "rejected" ? "rejected" : "failed";
  }
  // A workspace that could not be stored: say so, so the launcher does not wait for it.
  if (outcome !== "ok")
    await postCapped(
      withRound(`${base}/workspace-failed`, round),
      headers,
      undefined,
      policy,
      log,
      "workspace-failed",
      o.signal,
    );
  return outcome === "ok" ? "ok" : outcome === "rejected" ? "rejected" : "failed";
}
