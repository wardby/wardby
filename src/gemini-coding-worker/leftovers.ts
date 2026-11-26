import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The worker image bakes this empty, root-owned file (Dockerfile): the driver runs in the image's own
 * pid namespace. A file, not an environment variable: the launchers attest the worker's exact WARDBY_*
 * environment, and /opt/wardby is root-owned, so the agent cannot create it.
 */
export const WORKER_PID_NAMESPACE_MARKER = "/opt/wardby/worker-pid-namespace";
/** Stop-then-kill rounds: a process forked while a round ran is caught by the next one. */
const SWEEP_ROUNDS = 5;
const ROUND_PAUSE_MS = 50;
/** How long a killed process may take to exit (a D-state wait, a large process) before it counts as a survivor. */
export const KILLED_EXIT_WAIT_MS = 5_000;

export type SweepResult = "swept" | "skipped";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `pid (comm) state ppid ...`: comm may hold spaces and parentheses, so fields are read after its last ")". */
async function statOf(procRoot: string, pid: number): Promise<{ state: string; ppid: number } | undefined> {
  try {
    const stat = await readFile(join(procRoot, String(pid), "stat"), "utf8");
    const [state, ppid] = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    return { state, ppid: Number(ppid) };
  } catch {
    return undefined;
  }
}

async function pids(procRoot: string): Promise<number[]> {
  const names = await readdir(procRoot).catch(() => [] as string[]);
  return names
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

/** The driver and every process above it, up to the namespace's init. */
async function protectedPids(procRoot: string, self: number): Promise<Set<number>> {
  const keep = new Set([self]);
  let pid = self;
  for (let depth = 0; depth < 64; depth += 1) {
    const ppid = (await statOf(procRoot, pid))?.ppid;
    if (!ppid || keep.has(ppid)) break;
    keep.add(ppid);
    pid = ppid;
  }
  return keep;
}

/** Live processes the sweep may stop: not the driver or its ancestors, not zombies (nothing to signal). */
async function targets(procRoot: string, keep: Set<number>): Promise<number[]> {
  const found: number[] = [];
  for (const pid of await pids(procRoot)) {
    if (keep.has(pid)) continue;
    const stat = await statOf(procRoot, pid);
    if (stat && stat.state !== "Z" && stat.state !== "X") found.push(pid);
  }
  return found;
}

/** The marker is a regular file (not a link) owned by `uid` (root in the image). */
async function markerPresent(path: string, uid: number): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && metadata.uid === uid;
  } catch {
    return false;
  }
}

/** Sends a signal; false when the process is not ours to signal (another uid). Gone already is fine. */
function signal(kill: (pid: number, signal: NodeJS.Signals) => void, pid: number, name: NodeJS.Signals): boolean {
  try {
    kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
  }
  return true;
}

/**
 * Stops every process left in the worker's pid namespace except the driver and its ancestors. The
 * CLI's shell commands run in process groups of their own, so ending the CLI's group (process.ts)
 * does not reach a command the agent left running in the background; one still writing to the
 * workspace would race the diff, or change the CLI's state before the next turn. Runs before and
 * after every CLI run.
 *
 * Only inside the worker image's own pid namespace: the image bakes WORKER_PID_NAMESPACE_MARKER (a
 * regular file owned by root), and PID 1 (the container's init) must be one of the driver's ancestors. Anywhere else (a developer
 * machine, a namespace shared with other processes, no /proc) it signals nothing and returns
 * "skipped".
 *
 * Each round SIGSTOPs every new target first (a stopped process cannot fork), then SIGKILLs them,
 * then looks again. A killed process gets KILLED_EXIT_WAIT_MS to exit (become a zombie or vanish);
 * new pids after the last round, or a killed one still alive after the wait, throw
 * coding_stream_failed: the run never goes on with the agent's processes alive. Processes it may not signal (another
 * uid) are not the agent's and are left alone.
 */
export async function killLeftoverProcesses(
  options: {
    procRoot?: string;
    self?: number;
    /** WORKER_PID_NAMESPACE_MARKER by default. */
    markerPath?: string;
    /** Tests only: the marker's expected owner (root by default). */
    markerUid?: number;
    pauseMs?: number;
    /** KILLED_EXIT_WAIT_MS by default. */
    exitWaitMs?: number;
    /** Tests only: called before each scan of the loop. */
    onScan?: () => void;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<SweepResult> {
  if (!(await markerPresent(options.markerPath ?? WORKER_PID_NAMESPACE_MARKER, options.markerUid ?? 0))) {
    return "skipped";
  }
  const procRoot = options.procRoot ?? "/proc";
  const kill = options.kill ?? ((pid, name) => process.kill(pid, name));
  const pause = options.pauseMs ?? ROUND_PAUSE_MS;
  if ((await pids(procRoot)).length === 0) return "skipped";
  const keep = await protectedPids(procRoot, options.self ?? process.pid);
  if (!keep.has(1)) return "skipped";
  const notOurs = new Set<number>();
  const killed = new Set<number>();
  const exitWait = options.exitWaitMs ?? KILLED_EXIT_WAIT_MS;
  const left = async () => (await targets(procRoot, keep)).filter((pid) => !notOurs.has(pid));
  let rounds = 0;
  let lastKill = 0;
  for (;;) {
    options.onScan?.();
    const found = await left();
    if (found.length === 0) return "swept";
    const fresh = found.filter((pid) => !killed.has(pid));
    if (fresh.length > 0) {
      // New pids (forked before they were stopped): another stop-then-kill round, a bounded number of times.
      if (rounds >= SWEEP_ROUNDS) throw new Error("coding_stream_failed");
      rounds += 1;
      for (const pid of fresh) if (!signal(kill, pid, "SIGSTOP")) notOurs.add(pid);
      for (const pid of fresh) {
        if (notOurs.has(pid)) continue;
        signal(kill, pid, "SIGKILL");
        killed.add(pid);
      }
      lastKill = Date.now();
    } else if (Date.now() - lastKill >= exitWait) {
      // Only processes already killed are left, and they had their time to exit.
      throw new Error("coding_stream_failed");
    }
    await sleep(pause);
  }
}
