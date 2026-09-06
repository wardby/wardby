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

export const FETCH_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const RANDOM_BYTES_LIMIT = 65_536;
export const BRIDGE_INPUT_BYTES = 1024 * 1024;
export const BRIDGE_RESULT_BYTES = 12 * 1024 * 1024;
export const PARSER_INPUT_BYTES = 256 * 1024;
export const HTML_LINKS_LIMIT = 1000;
export const LOG_BYTES = 16 * 1024;
export const MAX_HOST_CALLS = 256;
export const MAX_PENDING_HOST_CALLS = 8;

/** Max concurrent parser worker threads across the whole process (html/csv/xml bridge calls share this budget). */
export const PARSER_WORKER_MAX_CONCURRENCY = 4;
/** Max callers waiting for a free worker slot before a new call is rejected immediately instead of queueing. */
export const PARSER_WORKER_QUEUE_LIMIT = 32;
/** Hard wall-clock budget for one parse call; the worker is forcibly terminated if it runs longer. */
export const PARSER_WORKER_TIMEOUT_MS = 5_000;
/** Per-worker V8 old-generation heap cap (resourceLimits) — see plan D2 for its known Buffer-allocation blind spot. */
export const PARSER_WORKER_MAX_OLD_GEN_MB = 64;
