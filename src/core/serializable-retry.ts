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
