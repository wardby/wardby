import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** After SIGTERM, the wait before SIGKILL. */
export const LEFTOVER_GRACE_MS = 2_000;
/** SIGKILL rounds after the grace: a process forked while the sweep ran is caught by the next one. */
const KILL_ROUNDS = 3;
const KILL_ROUND_PAUSE_MS = 50;

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

function signal(kill: (pid: number, signal: NodeJS.Signals) => void, pid: number, name: NodeJS.Signals): void {
  try {
    kill(pid, name);
  } catch {
    // Gone already, or not ours to signal (another uid).
  }
}

/**
 * Stops every process left in the worker's pid namespace except the driver and its ancestors. The
 * CLI's shell commands run in process groups of their own, so ending the CLI's group (process.ts)
 * does not reach a command the agent left running in the background; one still writing to the
 * workspace would race the diff, or change the CLI's state before the next turn. Runs after every
 * CLI run. Only on Linux (no /proc elsewhere: a no-op). SIGTERM, a short grace, then SIGKILL rounds.
 */
export async function killLeftoverProcesses(
  options: {
    procRoot?: string;
    self?: number;
    graceMs?: number;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<void> {
  const procRoot = options.procRoot ?? "/proc";
  const kill = options.kill ?? ((pid, name) => process.kill(pid, name));
  const keep = await protectedPids(procRoot, options.self ?? process.pid);
  const first = await targets(procRoot, keep);
  if (first.length === 0) return;
  for (const pid of first) signal(kill, pid, "SIGTERM");
  await sleep(options.graceMs ?? LEFTOVER_GRACE_MS);
  for (let round = 0; round < KILL_ROUNDS; round += 1) {
    const left = await targets(procRoot, keep);
    if (left.length === 0) return;
    for (const pid of left) signal(kill, pid, "SIGKILL");
    await sleep(KILL_ROUND_PAUSE_MS);
  }
}
