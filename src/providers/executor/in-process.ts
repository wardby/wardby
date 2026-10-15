/**
 * Phase 2's default `Executor`: runs `executeRun` in-process, providing
 * durability via a heartbeat. If this process dies mid-run the heartbeat
 * stops, and the reconciler (core/reconciler.ts) detects the stale
 * heartbeat and recovers the run to `lost` rather than leaving it stuck
 * `running` forever.
 */

import {
  executeRun,
  failNativeRun,
  nativeRunIntegrations,
  RunCancelledError,
  type NativeRunProviders,
  type RunnerDb,
} from "../../core/runner.js";
import { prisma as defaultDb } from "../../core/db.js";
import { HEARTBEAT_INTERVAL_MS } from "../../core/timing.js";
import type { Executor } from "./types.js";

export class InProcessExecutor implements Executor {
  constructor(
    private readonly providers: NativeRunProviders,
    private readonly db: RunnerDb = defaultDb,
    private readonly heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {}

  async start(runId: string): Promise<void> {
    const beat = () =>
      this.db.run.update({ where: { id: runId }, data: { heartbeatAt: new Date() } }).catch(() => {
        // A missed heartbeat write just makes the reconciler's stale-heartbeat
        // check trigger a little sooner — never fatal to the run itself.
      });

    await beat();
    const timer = setInterval(() => void beat(), this.heartbeatIntervalMs);
    try {
      await executeRun(runId, this.providers, this.db);
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Records the run cancelled (only while it is still pending or running: the first terminal write
   * wins) and settles it like any finished run (its review check, status comments, notifications).
   * The engine itself is stopped cooperatively: executeRun's inline step runner reads the run's row
   * before every step (stopAwareStep), so the process executing it, this one or another, stops it
   * at the next step boundary, and a run that has not started yet never does. A step already in
   * flight (one model turn or tool call) finishes first; its spend is still recorded.
   */
  async stop(runId: string, reason?: string): Promise<void> {
    const run = await this.db.run.findUnique({ where: { id: runId }, select: { status: true } });
    if (!run || (run.status !== "pending" && run.status !== "running")) return;
    await failNativeRun(
      { runId, db: this.db, providers: this.providers, ...nativeRunIntegrations(this.providers, this.db) },
      new RunCancelledError(reason ?? "The run was cancelled."),
    );
  }
}
