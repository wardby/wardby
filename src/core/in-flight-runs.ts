/**
 * Counts the native runs executing in this process, so a shutdown can wait
 * for them instead of abandoning them. Every native run, however it was
 * started (a direct start, a DBOS workflow, a workflow adopted from a dead
 * instance), goes through executeRun, which registers here. Coding jobs are
 * not counted: they run in their own pods and a new instance collects them.
 */
import { logger } from "./logger.js";

const log = logger.child({ module: "in-flight-runs" });

const active = new Set<string>();
let waiters: Array<() => void> = [];

/** Registers a run for the duration of `work`. */
export async function trackRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
  active.add(runId);
  try {
    return await work();
  } finally {
    active.delete(runId);
    if (active.size === 0) {
      const done = waiters;
      waiters = [];
      for (const wake of done) wake();
    }
  }
}

export function inFlightRunIds(): string[] {
  return [...active];
}

/**
 * Resolves once no run is executing, or after `timeoutMs`, whichever is
 * first. Returns the ids still executing at that point (empty when drained).
 */
export async function waitForInFlightRuns(timeoutMs: number): Promise<string[]> {
  if (active.size === 0 || timeoutMs <= 0) return inFlightRunIds();
  log.info({ runIds: inFlightRunIds(), timeoutMs }, "waiting for in-flight runs before shutdown");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== wake);
      resolve();
    }, timeoutMs);
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.push(wake);
  });
  const remaining = inFlightRunIds();
  if (remaining.length > 0) log.warn({ runIds: remaining }, "shutdown drain timed out; these runs are abandoned");
  else log.info("in-flight runs finished; shutting down");
  return remaining;
}
