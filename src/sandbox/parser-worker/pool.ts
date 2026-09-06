/**
 * Bounds the three parser bridge functions (HTML/CSV/XML) to a fixed
 * number of concurrent, isolated worker threads with a hard per-call
 * timeout. These parsers run fully attacker-controlled (but size-capped)
 * input through third-party libraries in the HOST Node process — QuickJS's
 * own CPU/memory/wall-time limits don't apply to that work at all, and an
 * AbortSignal alone cannot interrupt a synchronous CPU-bound call already
 * in flight. A worker thread's terminate() can (verified: kills a genuine
 * synchronous infinite loop in ~300ms) — this module pairs that
 * termination primitive with a bounded concurrency gate and queue so a
 * pathological input degrades one call, not the whole process.
 *
 * Deliberately spawn-per-call rather than a persistent reused pool: a
 * dead/terminated worker just isn't reused, so there's no "respawn a
 * broken slot" state machine to get wrong after an attack. The cost is a
 * few ms of thread-spawn overhead per call, negligible against the
 * multi-second timeout budget this exists to bound.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  PARSER_WORKER_MAX_CONCURRENCY,
  PARSER_WORKER_MAX_OLD_GEN_MB,
  PARSER_WORKER_QUEUE_LIMIT,
  PARSER_WORKER_TIMEOUT_MS,
} from "../limits.js";

export type ParserKind = "html" | "csv" | "xml";

export interface ParserWorkerPool {
  run(kind: ParserKind, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface ParserWorkerPoolOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
  queueLimit?: number;
  /** Test-only escape hatch: which worker script to spawn (real workers point fixtures here instead). */
  workerUrl?: URL;
}

const defaultWorkerJsUrl = new URL("./worker.js", import.meta.url);
// `new Worker()` loads by literal file URL — it gets none of the NodeNext
// ".js"-import-resolves-to-".ts" remapping tsx/vitest give normal `import`
// statements. Under tsx/vitest only worker.ts exists on disk; after
// `tsc -p tsconfig.build.json` only the compiled worker.js does. Verified
// both branches load and run correctly.
const DEFAULT_WORKER_URL = existsSync(fileURLToPath(defaultWorkerJsUrl)) ? defaultWorkerJsUrl : new URL("./worker.ts", import.meta.url);

export function createParserWorkerPool(options: ParserWorkerPoolOptions = {}): ParserWorkerPool {
  const maxConcurrency = options.maxConcurrency ?? PARSER_WORKER_MAX_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? PARSER_WORKER_TIMEOUT_MS;
  const maxOldGenerationSizeMb = options.maxOldGenerationSizeMb ?? PARSER_WORKER_MAX_OLD_GEN_MB;
  const queueLimit = options.queueLimit ?? PARSER_WORKER_QUEUE_LIMIT;
  const workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL;

  let active = 0;
  const waiters: (() => void)[] = [];

  async function acquire(): Promise<void> {
    if (active < maxConcurrency) {
      active++;
      return;
    }
    if (waiters.length >= queueLimit) throw new Error("parser_pool_saturated");
    await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
  }

  function release(): void {
    active--;
    const next = waiters.shift();
    if (next) next();
  }

  async function run(kind: ParserKind, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error("parser_aborted");
    await acquire();
    if (signal?.aborted) {
      release();
      throw new Error("parser_aborted");
    }

    const worker = new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb } });
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error("parser_timeout"))), timeoutMs);
        const onAbort = () => finish(() => reject(new Error("parser_aborted")));
        signal?.addEventListener("abort", onAbort, { once: true });

        worker.once("message", (msg: { ok: boolean; value?: unknown; message?: string }) => {
          finish(() => (msg.ok ? resolve(msg.value) : reject(new Error(msg.message ?? "parser_failed"))));
        });
        worker.once("error", (err: Error) => {
          finish(() => reject(new Error(`parser_worker_crashed: ${err.message}`)));
        });
        worker.once("exit", (code: number) => {
          finish(() => reject(new Error(`parser_worker_terminated: exit code ${code}`)));
        });

        worker.postMessage({ kind, payload });
      });
    } finally {
      await worker.terminate().catch(() => {});
      release();
    }
  }

  return { run };
}
