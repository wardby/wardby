/**
 * The warm pool's rows (native sandbox phase 6, docs/native-sandbox.md): one per pool worker,
 * inserted before the worker is created. A run claims an idle worker with one conditional update
 * (`FOR UPDATE SKIP LOCKED`), so two claims — from any replica or process — never take the same
 * worker, and a run never holds two (`runId` is unique).
 */

import type { NativeWarmWorker, PrismaClient } from "#prisma";

export type WarmPoolDb = Pick<PrismaClient, "$transaction" | "$queryRaw" | "nativeWarmWorker">;

export type WarmWorkerRow = NativeWarmWorker;

export class PrismaWarmPoolLedger {
  constructor(private readonly db: WarmPoolDb) {}

  /**
   * Inserts `warming` rows for the pool's deficit (size minus its warming and idle workers of this
   * spec) and returns them. Serialized per spec, so concurrent callers never overshoot the size.
   */
  async reserve(
    specHash: string,
    size: number,
    newToken: () => string,
    nameFor: (token: string) => string,
  ): Promise<{ id: string; name: string }[]> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`wardby-native-warm-pool:${specHash}`}))::text`;
      const have = await tx.nativeWarmWorker.count({ where: { specHash, status: { in: ["warming", "idle"] } } });
      const rows = Array.from({ length: Math.max(0, size - have) }, () => {
        const id = newToken();
        return { id, name: nameFor(id), specHash };
      });
      if (rows.length > 0) await tx.nativeWarmWorker.createMany({ data: rows });
      return rows.map(({ id, name }) => ({ id, name }));
    });
  }

  /** A warming worker's isolation is proven: it becomes claimable. False when it was retired meanwhile. */
  async markIdle(id: string): Promise<boolean> {
    const { count } = await this.db.nativeWarmWorker.updateMany({
      where: { id, status: "warming" },
      data: { status: "idle", readyAt: new Date() },
    });
    return count === 1;
  }

  /** Takes one idle worker of this spec, born after `bornAfter`, for the run; null when there is none. */
  async claim(runId: string, specHash: string, bornAfter: Date): Promise<{ id: string; name: string } | null> {
    const rows = await this.db.$queryRaw<{ id: string; name: string }[]>`
      UPDATE "NativeWarmWorker"
      SET "status" = 'claimed', "runId" = ${runId}, "claimedAt" = now(), "updatedAt" = now()
      WHERE "id" = (
        SELECT "id" FROM "NativeWarmWorker"
        WHERE "status" = 'idle' AND "specHash" = ${specHash} AND "createdAt" > ${bornAfter}
        ORDER BY "readyAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "name"`;
    return rows[0] ?? null;
  }

  forRun(runId: string): Promise<WarmWorkerRow | null> {
    return this.db.nativeWarmWorker.findUnique({ where: { runId } });
  }

  /** Takes an idle worker out of the pool for removal; false when it was claimed (or is gone). */
  async retire(id: string): Promise<boolean> {
    const { count } = await this.db.nativeWarmWorker.updateMany({
      where: { id, status: "idle" },
      data: { status: "retiring" },
    });
    return count === 1;
  }

  async remove(id: string): Promise<void> {
    await this.db.nativeWarmWorker.deleteMany({ where: { id } });
  }

  count(): Promise<number> {
    return this.db.nativeWarmWorker.count();
  }

  /** Every pool row, with its run's status (the maintenance tick's view; the pool is small). */
  workers(): Promise<(WarmWorkerRow & { run: { status: string } | null })[]> {
    return this.db.nativeWarmWorker.findMany({ include: { run: { select: { status: true } } } });
  }
}
