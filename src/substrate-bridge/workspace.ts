/**
 * The workspace steps a bridge that holds the run's workspace takes: fetch its setup, extract the
 * seed, end a child's process group, and tar and upload the workspace. The tool bridge (pair runs)
 * and the Codex bridge (one-actor runs) share them.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * Nothing secret is logged (see Logger in common.ts); a setup body is never logged.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
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

/** Whether anything of ours is left in the child's process group (false once ESRCH or EPERM, or with no pid). */
function groupAlive(child: GroupSignalTarget): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    const code = errnoOf(err);
    return code !== "ESRCH" && code !== "EPERM";
  }
}

const GROUP_POLL_MS = 20;
/** How long after the SIGKILL the group is waited for (it goes at once; this only bounds a stuck one). */
const GROUP_KILL_WAIT_MS = 2_000;

async function waitGroupGone(child: GroupSignalTarget, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (!groupAlive(child)) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
}

/**
 * Ends a child and every process it started (its process group): SIGTERM, up to `graceMs` for the
 * group to go, then SIGKILL to whatever is left, and a bounded wait for it to be gone.
 */
export async function endGroup(child: GroupSignalTarget, graceMs: number, log: Logger): Promise<void> {
  if (child.pid === undefined) return;
  signalGroup(child, "SIGTERM", undefined, log);
  if (await waitGroupGone(child, graceMs)) return;
  signalGroup(child, "SIGKILL", undefined, log);
  if (!(await waitGroupGone(child, GROUP_KILL_WAIT_MS))) log("substrate_bridge_group_still_running");
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
