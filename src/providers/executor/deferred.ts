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
import type { Executor } from "./types.js";

const deferredLog = logger.child({ module: "deferred-executor" });

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
}

/**
 * Starts runs a deferred executor dispatched, and stops runs it asked to stop, through the
 * server's executor. Called on the scheduler leader's tick. Each row is claimed by clearing its
 * marker in a conditional update first, so two drains never start or stop the same run twice.
 */
export async function drainDeferredRuns(
  options: DrainDeferredRunsOptions,
): Promise<{ started: number; stopped: number }> {
  const { db, executor } = options;
  const limit = options.limit ?? 50;
  let started = 0;
  let stopped = 0;

  const toStart = await db.run.findMany({
    where: { startDeferredAt: { not: null }, status: "pending" },
    orderBy: { startDeferredAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const { id } of toStart) {
    const claimed = await db.run.updateMany({
      where: { id, startDeferredAt: { not: null }, status: "pending" },
      data: { startDeferredAt: null },
    });
    if (claimed.count === 0) continue;
    started += 1;
    // Not awaited: an in-process executor's start runs the whole run.
    void (async () => {
      if (options.beforeStart && !(await options.beforeStart(id))) return;
      await executor.start(id);
    })().catch(async (err: unknown) => {
      deferredLog.error({ err, runId: id }, "deferred run failed to start");
      await (options.onStartFailed?.(id, err) ??
        db.run.updateMany({
          where: { id, status: { in: ["pending", "running"] } },
          data: { status: "failed", error: err instanceof Error ? err.message : String(err), finishedAt: new Date() },
        }));
    });
  }

  const toStop = await db.run.findMany({
    where: { stopRequestedAt: { not: null } },
    orderBy: { stopRequestedAt: "asc" },
    take: limit,
    select: { id: true, stopRequestReason: true, status: true },
  });
  for (const row of toStop) {
    const claimed = await db.run.updateMany({
      where: { id: row.id, stopRequestedAt: { not: null } },
      data: { stopRequestedAt: null, stopRequestReason: null },
    });
    if (claimed.count === 0 || !["pending", "running"].includes(row.status)) continue;
    stopped += 1;
    await executor.stop(row.id, row.stopRequestReason ?? undefined).catch((err: unknown) => {
      deferredLog.warn({ err, runId: row.id }, "deferred stop request failed");
    });
  }
  return { started, stopped };
}
