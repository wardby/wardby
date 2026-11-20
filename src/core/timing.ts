/** Scheduler/executor/reconciler timing constants — one module, tunable. */

export const TICK_INTERVAL_MS = 10_000;
export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_INTERVAL_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
export const RECONCILE_INTERVAL_MS = 15_000;
/**
 * How long one pass of a background loop may run before `startInterval` abandons it so the next can
 * start. Generous: a pass can legitimately drain a queue; this only has to catch a query that never
 * returns. The scheduler's lease pass is a single query, so it is held to the lease's own lifetime.
 */
export const LOOP_TICK_TIMEOUT_MS = 120_000;
export const LEASE_TICK_TIMEOUT_MS = LEASE_TTL_MS;
/**
 * How long a lock-serialized transaction (dispatch, coding slot claim) waits
 * for a pooled connection before Prisma gives up with P2028. Prisma's default
 * is 2 s, which a burst of a few hundred grouped dispatches or claims queued
 * on one lock exceeds while every connection waits its turn.
 */
export const CONTENDED_TX_MAX_WAIT_MS = 10_000;
