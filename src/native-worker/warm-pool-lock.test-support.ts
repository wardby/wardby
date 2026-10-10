import pg from "pg";

/**
 * A pool's maintenance tick reads every `NativeWarmWorker` row, not just its own spec's (replicas
 * share one pool), so two database suites ticking pools against the same table at once discard
 * each other's claimed rows. Each such suite holds this session-level advisory lock for its whole
 * run, so they take turns. Arbitrary but fixed key.
 */
const WARM_POOL_TEST_LOCK = 7_265_310_418;

/** Waits for the warm-pool table to be free, and returns the release. */
export async function lockWarmPoolTable(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [WARM_POOL_TEST_LOCK]);
  return async () => {
    await client.query("SELECT pg_advisory_unlock($1)", [WARM_POOL_TEST_LOCK]).catch(() => {});
    await client.end();
  };
}

/** How long a suite's `beforeAll` may wait for another suite to release the lock. */
export const LOCK_WAIT_MS = 180_000;
