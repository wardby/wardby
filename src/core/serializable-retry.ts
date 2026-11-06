/**
 * A bounded retry for short Serializable transactions on admin and owner actions (make_owner,
 * attach_mcp_server, grant/revoke that prune attachments). Postgres aborts one side of a conflicting
 * pair; nothing of the aborted attempt was committed, so running it again is safe. Only serialization
 * conflicts (isSerializationConflict: P2034, a raw-statement 40001/40P01, or one at COMMIT) are
 * retried; anything else, and the last attempt's conflict, is rethrown for mapPrismaError (409).
 */
import { isSerializationConflict } from "./dispatch.js";

const BASE_DELAY_MS = 20;
const MAX_DELAY_MS = 250;

/** Jittered exponential backoff: half the ceiling plus up to half again. */
function delayMs(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * Run first inside each of those transactions (make_owner, attach_mcp_server, grant/revoke). Postgres's Serializable mode takes a predicate (SIREAD)
 * lock on everything a statement reads, and a sequential scan locks the whole relation and checks every
 * row in it for conflicts. On small tables (a fresh deployment, or a test database) the planner picks a
 * sequential scan even for a primary-key lookup, so two admin actions on unrelated agents read each
 * other's rows and abort one another, retry after retry, while either keeps running. The Postgres manual
 * ("Serializable Isolation Level") recommends steering these transactions to index scans; their queries
 * are keyed by indexed agent, server or resource ids, so turning sequential scans off for this
 * transaction only (SET LOCAL) narrows the locks to the rows and index pages actually read. It changes
 * plans, never results: a query with no usable index still scans.
 */
export async function preferIndexScans(tx: { $executeRawUnsafe(query: string): Promise<number> }): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
}

export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isSerializationConflict(err) || attempt >= attempts - 1) throw err;
      await sleep(delayMs(attempt));
    }
  }
}
