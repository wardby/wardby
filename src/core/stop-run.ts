/**
 * Stopping a run on request (the stop_run MCP tool). Every executor already owns the stop of the
 * runs it executes (`Executor.stop`), and each makes the terminal write itself, conditional on the
 * run still being pending or running, so the first terminal write wins and a finished run is never
 * rewritten:
 *
 * - a native run in the control plane is recorded `cancelled` and stops at its next step boundary
 *   (InProcessExecutor/DbosExecutor; a run that has not started never does);
 * - a native run in the sandbox is recorded `cancelled`, its gateway session ends so the worker's
 *   next call is refused, and after a short grace its worker is killed and removed
 *   (NativeSandboxExecutor);
 * - a coding run, queued for a slot or running, is recorded `cancelled` first (the fence that keeps
 *   a finishing run from pushing or opening a pull request), then its proxy session is cancelled and
 *   its job stopped and removed (ContainerExecutor).
 *
 * This module adds what a caller asks for on top: the run's in-flight delegated child runs are
 * stopped too (depth-first, so nothing keeps spending for a parent that stopped), who stopped it
 * and why is kept on the row (Run.stopRequestReason) and logged, and a run already finished is
 * returned unchanged.
 */
import type { PrismaClient, RunStatus } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import { logger } from "./logger.js";

const stopLog = logger.child({ module: "stop-run" });

const DRIVABLE: readonly RunStatus[] = ["pending", "running"];

/** Delegation trees are shallow; this only bounds a malformed one. */
const MAX_CHILD_DEPTH = 16;

export type StopRunDb = Pick<PrismaClient, "run">;

export interface StopRunOptions {
  db: StopRunDb;
  executor: Pick<Executor, "stop">;
  runId: string;
  /** Who asked (a principal id), recorded with the reason. */
  stoppedBy: string;
  /** The caller's own words, if any. */
  reason?: string;
}

export interface StopRunResult {
  runId: string;
  /** The run's status before this call. */
  previousStatus: RunStatus;
  /** The run's status after it: `cancelled` once stopped, or whatever it had already ended as. */
  status: RunStatus;
  /** False when the run had already finished: nothing was changed. */
  stopRequested: boolean;
  /** In-flight delegated child runs this call stopped as well. */
  stoppedChildRunIds: string[];
}

/** The text recorded on a stopped run: who stopped it and why. */
export function stopRunReason(stoppedBy: string, reason?: string): string {
  const why = reason?.trim();
  return `Stopped by ${stoppedBy} with stop_run${why ? `: ${why}` : "."}`;
}

export async function stopRun(options: StopRunOptions): Promise<StopRunResult> {
  const { db, runId } = options;
  const row = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
  if (!row) throw new Error(`Unknown run "${runId}".`);
  const previousStatus = row.status;
  if (!DRIVABLE.includes(previousStatus)) {
    return { runId, previousStatus, status: previousStatus, stopRequested: false, stoppedChildRunIds: [] };
  }
  const reason = stopRunReason(options.stoppedBy, options.reason);
  stopLog.info({ runId, stoppedBy: options.stoppedBy, previousStatus, reason }, "stopping run");
  const stoppedChildRunIds: string[] = [];
  await stopOne(options, runId, reason, stoppedChildRunIds, 0, new Set());
  const after = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
  return { runId, previousStatus, status: after.status, stopRequested: true, stoppedChildRunIds };
}

async function stopOne(
  options: StopRunOptions,
  runId: string,
  reason: string,
  stoppedChildRunIds: string[],
  depth: number,
  visited: Set<string>,
): Promise<void> {
  const { db, executor } = options;
  visited.add(runId);
  try {
    await executor.stop(runId, reason);
  } catch (err) {
    // Still stop the children and record the request: a failed stop is retried by calling again.
    stopLog.warn({ err, runId }, "the executor failed to stop the run");
  }
  // A run that never started has nothing to interrupt: end it here if no executor did.
  await db.run.updateMany({
    where: { id: runId, status: "pending" },
    data: { status: "cancelled", error: reason, finishedAt: new Date() },
  });
  // Kept for get_run; written only on a run this stop (or another) cancelled, never on one that
  // finished some other way meanwhile. stopRequestedAt stays null: it is the native sandbox
  // gateway's deferred-stop marker, which the scheduler leader drains.
  await db.run.updateMany({
    where: { id: runId, status: "cancelled", stopRequestReason: null },
    data: { stopRequestReason: reason },
  });

  if (depth >= MAX_CHILD_DEPTH) return;
  const children = await db.run.findMany({
    where: { parentRunId: runId, status: { in: [...DRIVABLE] } },
    select: { id: true },
  });
  for (const child of children) {
    if (visited.has(child.id)) continue;
    stoppedChildRunIds.push(child.id);
    await stopOne(
      options,
      child.id,
      `Parent run ${runId} was stopped. ${reason}`,
      stoppedChildRunIds,
      depth + 1,
      visited,
    );
  }
}
