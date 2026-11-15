/**
 * The workspace steps a bridge that holds the run's workspace takes: fetch its setup, extract the
 * seed, end a child's process group, and tar and upload the workspace. The tool bridge (pair runs)
 * and the Codex bridge (one-actor runs) share them.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * Nothing secret is logged (see Logger in common.ts); a setup body is never logged.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { postCapped, stderrLogger, uploadFile, withRound, type Logger } from "./common.js";
import { RESULT_BUNDLE_FILE } from "./constants.js";
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
 * Downloads the run's seed into `stage`, checks it (tar.ts) and extracts it into `workspace`. Throws
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
}): Promise<void> {
  const seedPath = join(o.stage, "seed.tar");
  try {
    const seed = await withRetry(
      () => send(o.url, { method: "GET", headers: o.headers, downloadTo: seedPath, timeoutMs: SEED_TIMEOUT_MS }),
      { policy: o.policy, deadlineMs: SEED_DEADLINE_MS },
    );
    if (seed.status !== 200) throw new BridgeError("substrate_bridge_seed_failed");
    const checked = await checkTarFile(seedPath, true);
    if (!checked.ok) {
      o.log("substrate_bridge_seed_unsafe", { reason: checked.reason });
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
  } catch (error) {
    if (error instanceof BridgeError && error.code !== "substrate_bridge_retry_exhausted") throw error;
    throw new BridgeError("substrate_bridge_seed_failed");
  } finally {
    await rm(seedPath, { force: true }).catch(() => undefined);
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
 * Tars the workspace (without `exclusions`) and uploads it; on a tar that could not be made, or an
 * upload that could not be stored, posts workspace-failed so the launcher does not wait for it.
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
}): Promise<"ok" | "rejected" | "failed"> {
  const { base, round, token, headers, workspace, stage, tar, exclusions, collectResultBundle, policy, log } = o;
  const tarPath = join(stage, "workspace.tar");
  const createExclusions = collectResultBundle
    ? { names: exclusions.names, paths: [...exclusions.paths, ".git"] }
    : exclusions;
  let code = await exec(tar, ["-c", "-C", workspace, ...tarExcludeArgs(createExclusions), "-f", tarPath, "."]);
  if ((code === 0 || code === 1) && collectResultBundle) {
    const bundleStage = await mkdtemp(join(stage, "bundle-"));
    try {
      const skipped = await stageResultBundle(workspace, bundleStage, o.beforeResultBundleRecheck);
      if (skipped) {
        log("substrate_bridge_result_bundle_skipped", { runToken: token, round, reason: skipped });
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
    log("substrate_bridge_collect_failed", { code: code === TAMPERED_CODE ? "result_bundle_tampered" : code });
    await rm(tarPath, { force: true }).catch(() => undefined);
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
  const outcome = await uploadFile(
    withRound(`${base}/workspace`, round),
    headers,
    tarPath,
    policy,
    log,
    "workspace",
    o.signal,
  );
  await rm(tarPath, { force: true }).catch(() => undefined);
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
