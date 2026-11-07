/**
 * Deletes run steps past RUN_STEP_RETENTION_DAYS (their expiresAt), in bounded batches. Runs on the
 * scheduler leader's tick, at most every RUN_STEP_SWEEP_INTERVAL_MS, so one replica sweeps.
 */
import type { PrismaClient } from "#prisma";
import { logger } from "../logger.js";

const sweepLog = logger.child({ module: "run-steps" });
export const RUN_STEP_SWEEP_INTERVAL_MS = 10 * 60_000;

export async function sweepExpiredRunSteps(
  db: Pick<PrismaClient, "$executeRaw">,
  now: Date = new Date(),
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 1_000;
  const maxBatches = opts.maxBatches ?? 10;
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const deleted = await db.$executeRaw`
      DELETE FROM "RunStep" WHERE "id" IN (
        SELECT "id" FROM "RunStep" WHERE "expiresAt" < ${now} ORDER BY "expiresAt" LIMIT ${batchSize}
      )`;
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export class RunStepSweeper {
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: Pick<PrismaClient, "$executeRaw">,
    private readonly options: { intervalMs?: number; now?: () => Date } = {},
  ) {}

  /** Sweeps if the interval has passed since the last attempt. Never rejects. */
  async maybeSweep(): Promise<number> {
    const now = (this.options.now ?? (() => new Date()))();
    if (now.getTime() - this.lastAt < (this.options.intervalMs ?? RUN_STEP_SWEEP_INTERVAL_MS)) return 0;
    this.lastAt = now.getTime();
    try {
      return await sweepExpiredRunSteps(this.db, now);
    } catch (err) {
      sweepLog.warn(
        { event: "run_steps_sweep_failed", errorName: err instanceof Error ? err.name : typeof err },
        "could not delete expired run steps; the next pass tries again",
      );
      return 0;
    }
  }
}
