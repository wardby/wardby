import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Captured when this module loads, outside any run: the empty async context.
 * Work a run's code sets off in the background otherwise inherits that run's
 * context, including a DBOS workflow step's, and DBOS refuses to start a
 * workflow (a new run) from inside a step.
 */
const atLoad = AsyncLocalStorage.snapshot();

/** Calls `fn` outside every async context, as if from the top level: what it starts is not part of the caller's run. */
export function outsideRunContext<T>(fn: () => T): T {
  return atLoad(fn);
}
