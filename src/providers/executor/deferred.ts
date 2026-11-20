/**
 * An Executor for a process that must never start or stop runs itself: the
 * native sandbox gateway (docs/native-sandbox.md). Sandbox workers can reach
 * the gateway, so it holds no Docker socket, cluster credential, or in-process
 * engine; a child it dispatches is only recorded (Run.startDeferredAt) and a
 * stop it needs only requested (Run.stopRequestedAt). The scheduler leader
 * carries both out through the server's own executor (`drainDeferredRuns`).
 *
 * Coding dispatch is recorded unresolved (`defersCodingResolution`): the worker image,
 * service declaration and knowledge files are resolved by the process that starts the run
 * (the drain's `beforeStart` hook), not here.
 */

import type { PrismaClient } from "#prisma";
import { logger } from "../../core/logger.js";
import { ExecutorClosingError, type Executor } from "./types.js";

const deferredLog = logger.child({ module: "deferred-executor" });

/**
 * How long a drain's claim on a deferred start holds before another drain may take it over. A
 * claim is not cleared until the start was attempted, so one older than this was left by a
 * leader that died: the next leader starts the run (a start on a started run attaches).
 */
export const DEFERRED_START_CLAIM_TIMEOUT_MS = 2 * 60_000;

export type DeferredExecutorDb = Pick<PrismaClient, "run">;

export class DeferredExecutor implements Executor {
  readonly defersCodingResolution = true;

  constructor(private readonly db: DeferredExecutorDb) {}

  async start(runId: string): Promise<void> {
    await this.db.run.updateMany({ where: { id: runId, status: "pending" }, data: { startDeferredAt: new Date() } });
  }

  async stop(runId: string, reason?: string): Promise<void> {
    // Never started: nothing runs it, so it can simply end here.
    const cancelled = await this.db.run.updateMany({
      where: { id: runId, status: "pending", startDeferredAt: { not: null } },
      data: {
        status: "cancelled",
        error: reason ?? "Cancelled before it started.",
        finishedAt: new Date(),
        startDeferredAt: null,
      },
    });
    if (cancelled.count > 0) return;
    await this.db.run.updateMany({
      where: { id: runId, status: { in: ["pending", "running"] } },
      data: { stopRequestedAt: new Date(), stopRequestReason: reason ?? null },
    });
  }
}

export interface DrainDeferredRunsOptions {
  db: Pick<PrismaClient, "run">;
  executor: Executor;
  /** Where a start failure is recorded; defaults to marking the run failed with the error. */
  onStartFailed?: (runId: string, err: unknown) => Promise<void>;
  /**
   * Runs after a row is claimed and before `executor.start`. Resolves inputs the deferring process
   * could not; false means the hook ended the run itself so it must not start. A throw is handled
   * like a start failure.
   */
  beforeStart?: (runId: string) => Promise<boolean>;
  limit?: number;
  now?: () => Date;
}

/**
 * Starts runs a deferred executor dispatched, and stops runs it asked to stop, through the
 * server's executor. Called on the scheduler leader's tick. Both act first and clear after, so a
 * leader that dies in between leaves the work for the next one:
 *
 * - A start is claimed with a timestamp (`startClaimedAt`) that stops a second drain starting the
 *   run, and the marker is cleared once the start was attempted. A claim older than
 *   DEFERRED_START_CLAIM_TIMEOUT_MS is taken over; executors attach to a run already started.
 * - A stop is carried out, then its marker cleared only if no newer request replaced it. Stopping
 *   a stopped run is a no-op, so a repeat is harmless; a failed stop stays requested for the next
 *   tick.
 */
export async function drainDeferredRuns(
  options: DrainDeferredRunsOptions,
): Promise<{ started: number; stopped: number }> {
  const { db, executor } = options;
  const limit = options.limit ?? 50;
  const now = options.now ?? (() => new Date());
  let started = 0;
  let stopped = 0;

  const claimable = () => ({
    startDeferredAt: { not: null },
    status: "pending" as const,
    OR: [
      { startClaimedAt: null },
      { startClaimedAt: { lt: new Date(now().getTime() - DEFERRED_START_CLAIM_TIMEOUT_MS) } },
    ],
  });
  const clearStart = (id: string) =>
    db.run.updateMany({ where: { id }, data: { startDeferredAt: null, startClaimedAt: null } });

  const toStart = await db.run.findMany({
    where: claimable(),
    orderBy: { startDeferredAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const { id } of toStart) {
    const claimed = await db.run.updateMany({
      where: { id, ...claimable() },
      data: { startClaimedAt: now() },
    });
    if (claimed.count === 0) continue;
    started += 1;
    // Not awaited: an in-process executor's start runs the whole run.
    void (async () => {
      if (options.beforeStart && !(await options.beforeStart(id))) return;
      await executor.start(id);
    })()
      .catch(async (err: unknown) => {
        // The executor was closing, not the run failing: keep the claim so the next leader starts it.
        if (err instanceof ExecutorClosingError) throw err;
        deferredLog.error({ err, runId: id }, "deferred run failed to start");
        await (options.onStartFailed?.(id, err) ??
          db.run.updateMany({
            where: { id, status: { in: ["pending", "running"] } },
            data: { status: "failed", error: err instanceof Error ? err.message : String(err), finishedAt: new Date() },
          }));
      })
      .then(() => clearStart(id))
      .catch((err: unknown) => {
        deferredLog.warn({ err, runId: id }, "deferred start left claimed for the next leader to take over");
      });
  }

  const toStop = await db.run.findMany({
    where: { stopRequestedAt: { not: null } },
    orderBy: { stopRequestedAt: "asc" },
    take: limit,
    select: { id: true, stopRequestReason: true, stopRequestedAt: true, status: true },
  });
  for (const row of toStop) {
    // Cleared only if no newer request replaced the one carried out.
    const clearStop = () =>
      db.run.updateMany({
        where: { id: row.id, stopRequestedAt: row.stopRequestedAt },
        data: { stopRequestedAt: null, stopRequestReason: null },
      });
    if (!["pending", "running"].includes(row.status)) {
      await clearStop();
      continue;
    }
    try {
      await executor.stop(row.id, row.stopRequestReason ?? undefined);
    } catch (err) {
      // Still requested: the next tick (or leader) tries again.
      deferredLog.warn({ err, runId: row.id }, "deferred stop request failed; it stays requested");
      continue;
    }
    stopped += 1;
    await clearStop();
  }
  return { started, stopped };
}
