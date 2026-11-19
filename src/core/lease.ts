/**
 * `SchedulerLease` acquisition — a single-row-per-scope lease so exactly one
 * scheduler process ticks at a time. Implemented as one atomic
 * `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` so acquire/renew/refuse
 * all resolve in a single round trip with no read-then-write race: the
 * `WHERE` clause only lets the write through when the lease is unheld,
 * expired, or already ours, and `RETURNING` tells the caller which case it
 * was — zero rows means someone else holds an unexpired lease.
 */

import type { PrismaClient } from "#prisma";

export type LeaseDb = Pick<PrismaClient, "$queryRaw">;

/**
 * Attempts to acquire (or renew) the lease for `scope`. Returns whether `holder` now holds it.
 * `expiresAt` is written from the database clock, the same one the `WHERE` compares it with, so a
 * process whose own clock is off cannot make a lease expire early or late.
 */
export async function tryAcquireLease(db: LeaseDb, scope: string, holder: string, ttlMs: number): Promise<boolean> {
  const rows = await db.$queryRaw<{ holder: string }[]>`
    INSERT INTO "SchedulerLease" ("scope", "holder", "expiresAt", "updatedAt")
    VALUES (${scope}, ${holder}, now() + ${ttlMs}::double precision * interval '1 millisecond', now())
    ON CONFLICT ("scope") DO UPDATE
    SET "holder" = EXCLUDED."holder", "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()
    WHERE "SchedulerLease"."expiresAt" < now() OR "SchedulerLease"."holder" = EXCLUDED."holder"
    RETURNING "holder"
  `;
  return rows.length > 0;
}

/**
 * Gives up the lease for `scope` so another process can take it on its next attempt instead of
 * waiting out the TTL. Only deletes a row `holder` still holds: a lease that already moved to
 * someone else is left alone. Returns whether a row was deleted.
 */
export async function releaseLease(db: LeaseDb, scope: string, holder: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ holder: string }[]>`
    DELETE FROM "SchedulerLease" WHERE "scope" = ${scope} AND "holder" = ${holder} RETURNING "holder"
  `;
  return rows.length > 0;
}
