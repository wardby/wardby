/**
 * Phase 2's default `Executor`: runs `executeRun` in-process, providing
 * durability via a heartbeat. If this process dies mid-run the heartbeat
 * stops, and the reconciler (core/reconciler.ts) detects the stale
 * heartbeat and recovers the run to `lost` rather than leaving it stuck
 * `running` forever.
 */

import { executeRun, type NativeRunProviders, type RunnerDb } from "../../core/runner.js";
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

  async stop(_runId: string, _reason?: string): Promise<void> {
    // Native engine cancellation remains cooperative until Engine accepts an
    // AbortSignal. The task state still records the caller's request.
  }
}
