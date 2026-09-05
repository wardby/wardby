/** Sandbox resource limits — one module, tunable. All defaulted. */

/** QuickJS heap ceiling per invocation (bytes). Trips a QuickJS-level OOM error. */
export const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024; // 32 MiB

/**
 * Interrupt-handler check budget. Counts interrupt-handler invocations (the
 * interpreter calls this periodically while running bytecode), not wall
 * time — deterministic, can't be gamed by a busy loop that happens to be
 * slow on one machine and fast on another.
 */
export const MAX_INTERRUPT_CHECKS = 20_000_000;

/**
 * Wall-time cap per tool invocation. Belt-and-suspenders alongside the
 * instruction cap: the interrupt handler only runs while the interpreter is
 * actively executing bytecode, so it can't bound time spent suspended
 * awaiting a host async call (e.g. a slow `fetch`) — this does.
 */
export const WALL_TIME_LIMIT_MS = 10_000;

/** Timeout for the sandbox's `fetch` host bridge, independent of the wall-time cap. */
export const FETCH_TIMEOUT_MS = 8_000;

/** QuickJS interpreter stack size cap (bytes). */
export const MAX_STACK_SIZE_BYTES = 1024 * 1024; // 1 MiB
