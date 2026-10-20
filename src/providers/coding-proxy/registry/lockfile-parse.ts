/**
 * Parses a lockfile in a disposable worker thread with a hard time bound,
 * for the formats that are costly to read (pnpm's and yarn's: YAML, or
 * yarn classic's own format). A lockfile is attacker-controlled up to the
 * 20 MiB plan cap, and a synchronous parse can't be interrupted, so on the
 * event loop a crafted one could stall every request the proxy serves (model
 * traffic included) for seconds. A worker's terminate() can stop it; the
 * event loop only deserializes the bounded result (entries and their edges).
 *
 * One worker per parse, never reused (the same choice as the sandbox's
 * parser pool): plans already run at most `planConcurrency` at once.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { RegistryError, type LockfileEntry, type ParsedLockfile } from "../../../coding/registry/types.js";
import type { ParseRequest, ParseResponse, ShippedLockfile } from "./lockfile-parse-worker.js";

/** Time one off-thread lockfile parse may take. Real lockfiles at the
 *  entry bound parse in well under a second. */
export const DEFAULT_LOCKFILE_PARSE_TIMEOUT_MS = 15_000;
/** Heap one parse worker may use before it is stopped, per 5000 entries
 *  the plan may have (REGISTRY_PLAN_MAX_ENTRIES, at least the default's
 *  share). A realistic 5000-entry pnpm-lock.yaml (3.4 MiB: peers, engines,
 *  six dependencies a snapshot) needs 129 to 160 MiB of it, so 384 MiB is
 *  about 2.5 times that; a crafted lockfile that expands further is
 *  stopped there and refused as too large. */
const PARSE_WORKER_HEAP_MB_PER_5000_ENTRIES = 384;

export function parseWorkerHeapMb(maxEntries: number): number {
  return Math.ceil((PARSE_WORKER_HEAP_MB_PER_5000_ENTRIES * Math.max(maxEntries, 5000)) / 5000);
}

const compiledWorker = new URL("./lockfile-parse-worker.js", import.meta.url);
// Under tsx/vitest only the .ts source exists, and a worker gets no TS
// loader by inheritance (see src/sandbox/parser-worker/pool.ts).
const WORKER_URL = existsSync(fileURLToPath(compiledWorker))
  ? compiledWorker
  : new URL("./lockfile-parse-worker.ts", import.meta.url);

function incomplete(message: string): RegistryError {
  return new RegistryError(503, "wardby_plan_incomplete", message);
}

/** The ParsedLockfile a worker shipped back, with `resolve` answering from
 *  its edge table. */
function rebuild(shipped: ShippedLockfile): ParsedLockfile {
  const byPath = new Map<string, Map<string, LockfileEntry>>();
  shipped.entries.forEach((entry, at) => {
    byPath.set(entry.path, new Map(shipped.edges[at].map(([key, target]) => [key, shipped.entries[target]])));
  });
  // A project's own dependencies (what package audit mode labels top-level);
  // a path an entry also uses keeps the entry's, as the parser's resolve does.
  shipped.projects.forEach((project, at) => {
    if (byPath.has(project.path)) return;
    byPath.set(project.path, new Map(shipped.projectEdges[at].map(([key, target]) => [key, shipped.entries[target]])));
  });
  return {
    entries: shipped.entries,
    projects: shipped.projects,
    ...(shipped.integrity ? { integrity: shipped.integrity } : {}),
    resolve: (fromPath, key) => byPath.get(fromPath)?.get(key),
    dependencyKeys: (path) => [...(byPath.get(path)?.keys() ?? [])],
  };
}

export async function parseLockfileOffThread(
  ecosystem: string,
  body: string,
  options: { maxEntries: number; proxyRegistryUrl: string },
  limits: {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Heap bound for the worker (default parseWorkerHeapMb(maxEntries)). */
    maxOldGenerationSizeMb?: number;
    /** Tests only: the worker script to run. */
    workerUrl?: URL;
  } = {},
): Promise<ParsedLockfile> {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_LOCKFILE_PARSE_TIMEOUT_MS;
  if (limits.signal?.aborted) throw incomplete("the client went away before the lockfile was read");
  const workerUrl = limits.workerUrl ?? WORKER_URL;
  const worker = new Worker(workerUrl, {
    resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb ?? parseWorkerHeapMb(options.maxEntries) },
    execArgv: workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx/esm"] : [],
  });
  try {
    const response = await new Promise<ParseResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(incomplete(`the lockfile was not read within ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      );
      const onAbort = () => reject(incomplete("the client went away before the lockfile was read"));
      limits.signal?.addEventListener("abort", onAbort, { once: true });
      const settle = () => {
        clearTimeout(timer);
        limits.signal?.removeEventListener("abort", onAbort);
      };
      worker.once("message", (message: ParseResponse) => {
        settle();
        resolve(message);
      });
      worker.once("error", (error: Error & { code?: string }) => {
        settle();
        // Out of heap: the lockfile expanded too far, a verdict about it.
        // Anything else (the worker failed to load, crashed) is the proxy's
        // own failure: a plain error, which the plan route logs and answers
        // as a failure to verify, never as a refusal of the lockfile.
        reject(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new RegistryError(413, "wardby_lockfile_too_large", "the lockfile needs too much memory to read")
            : new Error(`the lockfile reader failed: ${error.message}`, { cause: error }),
        );
      });
      worker.once("exit", (code) => {
        settle();
        reject(new Error(`the lockfile reader stopped (exit code ${code})`));
      });
      const request: ParseRequest = { ecosystem, body, ...options };
      worker.postMessage(request);
    });
    if (!response.ok) {
      if ("unexpected" in response) throw new Error(`the lockfile reader failed: ${response.message}`);
      throw new RegistryError(response.status, response.code, response.message);
    }
    return rebuild(response.lockfile);
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
