/**
 * Liveness for native runs that no executor watches: an attended
 * `wardby run` and a native sub-agent child, which runs inline inside its
 * parent's tool call. Managed runs already beat through their executor
 * (InProcessExecutor, DbosExecutor). A beat is what keeps a run's budget
 * hold counted against its budget group (budget-groups.ts isHoldLive): once a
 * process dies and the beats stop, the hold lapses on its own instead of
 * pinning the group for the rest of the period.
 */
import type { PrismaClient } from "#prisma";
import { HEARTBEAT_INTERVAL_MS } from "./timing.js";

type RunDb = Pick<PrismaClient, "run">;

async function beat(db: RunDb, runId: string): Promise<void> {
  try {
    await db.run.updateMany({
      where: { id: runId, status: { in: ["pending", "running"] } },
      data: { heartbeatAt: new Date() },
    });
  } catch {
    // A missed beat only lets the hold lapse a little sooner; never fatal to the run.
  }
}

/** Beats `runId` once now and every `intervalMs` until `fn` settles. */
export async function withRunHeartbeat<T>(
  db: RunDb,
  runId: string,
  fn: () => Promise<T>,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  await beat(db, runId);
  const timer = setInterval(() => void beat(db, runId), intervalMs);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** The part of `process` an interrupt handler needs (a fake in tests). */
export interface SignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): never | void;
}

const EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 130, SIGTERM: 143 };

/**
 * For an attended run: on SIGINT/SIGTERM, record the run as `cancelled`
 * (only if it is still pending/running) and exit with the conventional
 * 128+signal code, instead of leaving a `running` row behind. Returns a
 * function that removes the handlers once the run has finished.
 */
export function cancelRunOnSignal(db: RunDb, runId: string, target: SignalTarget = process): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const remove = () => {
    for (const [signal, handler] of handlers) target.off(signal, handler);
    handlers.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      remove();
      void db.run
        .updateMany({
          where: { id: runId, status: { in: ["pending", "running"] } },
          data: { status: "cancelled", error: `Interrupted by ${signal}.`, finishedAt: new Date() },
        })
        .catch(() => undefined)
        .finally(() => target.exit(EXIT_CODES[signal] ?? 1));
    };
    handlers.set(signal, handler);
    target.once(signal, handler);
  }
  return remove;
}
