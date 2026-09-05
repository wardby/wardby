/**
 * `SchedulerLease` acquisition — a single-row-per-scope lease so exactly one
 * scheduler process ticks at a time. Implemented as one atomic
 * `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` so acquire/renew/refuse
 * all resolve in a single round trip with no read-then-write race: the
 * `WHERE` clause only lets the write through when the lease is unheld,
 * expired, or already ours, and `RETURNING` tells the caller which case it
 * was — zero rows means someone else holds an unexpired lease.
 */

import type { PrismaClient } from "@prisma/client";

export type LeaseDb = Pick<PrismaClient, "$queryRaw">;

/** Attempts to acquire (or renew) the lease for `scope`. Returns whether `holder` now holds it. */
export async function tryAcquireLease(
  db: LeaseDb,
  scope: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const rows = await db.$queryRaw<{ holder: string }[]>`
    INSERT INTO "SchedulerLease" ("scope", "holder", "expiresAt", "updatedAt")
    VALUES (${scope}, ${holder}, ${expiresAt}, now())
    ON CONFLICT ("scope") DO UPDATE
    SET "holder" = EXCLUDED."holder", "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()
    WHERE "SchedulerLease"."expiresAt" < now() OR "SchedulerLease"."holder" = EXCLUDED."holder"
    RETURNING "holder"
  `;
  return rows.length > 0;
}
