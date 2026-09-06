# Parser Worker Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "Low-medium: HTML/CSV/XML parsers process fully attacker-controlled content" finding from the 2026-09-06 reevo-run code review. `__bridge_parseHTML`/`__bridge_parseCSV`/`__bridge_parseXML` (`src/sandbox/host-functions.ts:145-179`) currently call `node-html-parser`/`papaparse`/`fast-xml-parser` directly in the host Node process. QuickJS's own CPU/memory/wall-time limits (`src/sandbox/limits.ts`) do not apply to that host-side work at all, and the sandbox's `AbortSignal` cannot interrupt a synchronous CPU-bound call already in flight — so a crafted (but ≤256KB, per `PARSER_INPUT_BYTES`) input reaching a pathological code path in one of these libraries can stall the single shared Node event loop, which today is shared by the MCP server, the scheduler tick loop, and every other in-flight tool call in the process (verified: there is no existing process/thread isolation anywhere in this codebase — everything runs in one event loop).

**Architecture:** A new `src/sandbox/parser-worker/` module isolates the three parse calls into short-lived `node:worker_threads` workers, spawned per call under a bounded concurrency semaphore (not a persistent reused pool — deliberately simpler and more failure-tolerant; see Decisions Required D1). Each call gets its own hard wall-clock timeout that forcibly `terminate()`s the worker if exceeded — verified experimentally that `terminate()` actually preempts a genuine synchronous infinite loop in ~300ms, which a same-thread `AbortSignal` cannot do. `host-functions.ts`'s three bridge registrations keep their existing cheap pre-checks (size bound, DOCTYPE/ENTITY block, options allowlist) and delegate only the actual parse to the pool. No other part of the sandbox contract changes: a pool failure surfaces as a plain thrown `Error`, exactly like today's `html_link_limit`/`xml_entities_blocked`, so it becomes a normal catchable exception inside sandboxed tool code.

**Tech Stack:** TypeScript (`node:worker_threads`, no new npm dependency), Vitest.

**Spec:** No standalone spec doc — this plan implements the fix direction scoped in conversation on 2026-09-06 for the "Low-medium" parser-hardening item tracked in the user's `reevo-run-code-review-findings` memory. The scoping session verified (with disposable experiments run directly in this repo, since removed) that: (a) `new Worker(new URL("./worker.ts", import.meta.url))` correctly loads and transpiles a self-contained (no sibling imports) `.ts` worker under `tsx` and under this repo's real `vitest` config with no explicit `execArgv`, and resolves to the compiled `worker.js` once this file itself is compiled by `tsc -p tsconfig.build.json`; (b) `worker.terminate()` genuinely stops a synchronous `while(true)` loop; (c) an uncaught throw inside a worker's message handler surfaces as an `'error'` event on the parent, not a hang. **Correction found during Task 4 execution:** (a) was incomplete — it only held for a worker with no sibling-file imports. The real `worker.ts` imports `../bounded-json.js`/`../limits.js` (NodeNext convention), and that `.js`→`.ts` resolution needs an explicit `execArgv: ["--import", "tsx/esm"]` when the worker is a `.ts` file, because a worker spawned from a vitest-run process doesn't inherit a tsx loader the way one spawned from a `tsx`-launched process does. See Task 4's execution note for the full story.

## Global Constraints

- **No Prisma/schema changes in this plan.** CLAUDE.md's migration/drift-check workflow does not apply — nothing here touches `schema.prisma` or `prisma/migrations`.
- **No new npm dependency.** `node:worker_threads` is a Node builtin; do not reach for `piscina`/`workerpool` — see Decisions Required D1 for why a hand-rolled, spawn-per-call design was chosen over a persistent pool library.
- **Every new/changed file gets tests in the same task that changes it.**
- A pool/worker failure is always a plain `throw new Error("<snake_case_reason>")` from inside a `register(...)` handler in `host-functions.ts` — matching the existing convention (`html_link_limit`, `bridge_size_limit`, `xml_entities_blocked`) so it needs no new `SandboxErrorKind` in `eval-core.ts`.
- **D2 (memory limit) is resolved** — see Decisions Required D2. `PARSER_WORKER_MAX_OLD_GEN_MB = 64` (Task 1) is confirmed by experiment to correctly bound a realistic JS-heap allocation bomb for these three parsers; keep the docstring explaining the Buffer-allocation caveat (it's still true as a general Node fact) but don't reopen it as a blocker.

## Decisions Required

### D1: Spawn-per-call under a concurrency semaphore, not a persistent worker pool

A persistent pool (fixed long-lived workers, reused across calls) avoids per-call thread-spawn latency but requires a "respawn after crash/terminate" state machine per slot — more code, more ways to leave the pool in a wedged state after an attack. Spawn-per-call is simpler and self-healing by construction (a dead worker just isn't reused; there's nothing to repair), at the cost of a few milliseconds of thread-spawn overhead per parse call — negligible against the 5s+ timeout budget this exists to bound. Chosen: **spawn-per-call, bounded by a counting semaphore with a bounded FIFO wait queue** (`PARSER_WORKER_MAX_CONCURRENCY`, `PARSER_WORKER_QUEUE_LIMIT`). Worst-case wait for the last queued caller is bounded (`maxConcurrency` × `timeoutMs`, e.g. 4 × 5s = 20s with the defaults below) since every active slot is guaranteed to free up within `timeoutMs` at the latest.

### D2: Per-worker memory limit — RESOLVED

`resourceLimits.maxOldGenerationSizeMb` on the `Worker` constructor bounds the V8 JS heap (plain objects/strings/arrays — what these three parsers actually produce). Scoping first found that it does **not** bound raw `Buffer`/`ArrayBuffer` allocation (a `Buffer.alloc` loop ran past a 16MB cap for a full 10s test timeout without triggering `'error'`/`'exit'`) — Buffers live off the V8 heap. That's a real general Node fact, but a follow-up experiment confirmed it doesn't apply to this code path: a realistic JS-heap bomb (an ever-growing array of many bounded-size plain objects/strings — the actual shape an amplifying HTML/CSV/XML parse produces, as opposed to a single pathologically-doubling string, which hits V8's separate "Invalid string length" ceiling and gives a false pass/fail unrelated to `resourceLimits`) was correctly killed in ~97ms: `Worker terminated due to reaching memory limit: JS heap out of memory`. None of `node-html-parser`/`papaparse`/`fast-xml-parser` allocate `Buffer`s during parsing — they operate on JS strings/objects/arrays throughout — so the heap cap is the right mitigation for this specific threat model. `PARSER_WORKER_MAX_OLD_GEN_MB = 64` (Task 1) stands as the default; it's also a fast-path, not the only backstop — the per-call wall-clock timeout (D1) independently reclaims a worker via `terminate()` regardless of *why* it's unhealthy (CPU spin or memory thrashing), so even a hypothetical Buffer-based amplification would still be bounded, just on the timeout's slower clock instead of the heap cap's near-instant one.

---

## Task 1: Add pool-tuning constants to `limits.ts`

**Files:**
- Modify: `src/sandbox/limits.ts`
- Test: none (pure constants; exercised by Task 3's tests)

**Interfaces:**
- Produces: `PARSER_WORKER_MAX_CONCURRENCY`, `PARSER_WORKER_QUEUE_LIMIT`, `PARSER_WORKER_TIMEOUT_MS`, `PARSER_WORKER_MAX_OLD_GEN_MB` — consumed by Task 3's `pool.ts`.

- [x] **Step 1: Add the four constants**

Add to the end of `src/sandbox/limits.ts`:

```ts
/** Max concurrent parser worker threads across the whole process (html/csv/xml bridge calls share this budget). */
export const PARSER_WORKER_MAX_CONCURRENCY = 4;
/** Max callers waiting for a free worker slot before a new call is rejected immediately instead of queueing. */
export const PARSER_WORKER_QUEUE_LIMIT = 32;
/** Hard wall-clock budget for one parse call; the worker is forcibly terminated if it runs longer. */
export const PARSER_WORKER_TIMEOUT_MS = 5_000;
/** Per-worker V8 old-generation heap cap (resourceLimits) — see plan D2 for its known Buffer-allocation blind spot. */
export const PARSER_WORKER_MAX_OLD_GEN_MB = 64;
```

- [x] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (unused-export warnings don't fire; nothing consumes these yet, which is fine — `tsc --noEmit` doesn't flag unused exports).

- [x] **Step 3: Commit**

```bash
git add src/sandbox/limits.ts
git commit -m "feat(sandbox): add parser worker pool tuning constants"
```

---

## Task 2: Extract HTML/CSV/XML parsing into `parser-worker/worker.ts`

Pure extraction — moves the existing parsing logic out of `host-functions.ts` into pure, directly-testable functions, plus the worker-thread message wiring. Does not yet touch `host-functions.ts`; that's Task 4. Safe to land on its own.

**Files:**
- Create: `src/sandbox/parser-worker/worker.ts`
- Create: `src/sandbox/parser-worker/worker.test.ts`

**Interfaces:**
- Produces: `parseHtmlPayload(html: string): { title: string | null; text: string; links: { href: string; text: string }[] }`, `parseCsvPayload(csv: string, header: boolean): { data: unknown; errors: unknown; meta: unknown }`, `parseXmlPayload(xml: string, xmlOptions: Record<string, unknown> | null): unknown` — consumed directly by this task's tests, and indirectly (via the message handler, not by import) by Task 3's pool.
- Consumes: `boundedJson` (`../bounded-json.js`), `BRIDGE_RESULT_BYTES`, `HTML_LINKS_LIMIT` (`../limits.js`) — both already exist today.

- [x] **Step 1: Write the failing tests**

Create `src/sandbox/parser-worker/worker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCsvPayload, parseHtmlPayload, parseXmlPayload } from "./worker.js";
import { HTML_LINKS_LIMIT } from "../limits.js";

describe("parseHtmlPayload", () => {
  it("extracts title, visible text, and links", () => {
    const result = parseHtmlPayload('<html><head><title>Hi</title></head><body><p>Hello</p><a href="/a">A</a></body></html>');
    expect(result.title).toBe("Hi");
    expect(result.text).toContain("Hello");
    expect(result.links).toEqual([{ href: "/a", text: "A" }]);
  });

  it("throws html_link_limit past HTML_LINKS_LIMIT anchors", () => {
    const html = '<a href="/">x</a>'.repeat(HTML_LINKS_LIMIT + 1);
    expect(() => parseHtmlPayload(html)).toThrow("html_link_limit");
  });
});

describe("parseCsvPayload", () => {
  it("parses headered CSV into row objects", () => {
    const result = parseCsvPayload("a,b\n1,2", true);
    expect(result.data).toEqual([{ a: "1", b: "2" }]);
  });

  it("parses headerless CSV into row arrays", () => {
    const result = parseCsvPayload("1,2", false);
    expect(result.data).toEqual([["1", "2"]]);
  });
});

describe("parseXmlPayload", () => {
  it("parses simple XML into a plain object", () => {
    expect(parseXmlPayload("<x>hi</x>", null)).toEqual({ x: "hi" });
  });

  it("never resolves entities even if xmlOptions doesn't say so — processEntities is force-disabled", () => {
    const result = parseXmlPayload("<x>&amp;</x>", null) as { x: string };
    expect(result.x).not.toBe("&");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sandbox/parser-worker/worker.test.ts`
Expected: FAIL — `Cannot find module './worker.js'` (file doesn't exist yet).

- [x] **Step 3: Write `worker.ts`**

Create `src/sandbox/parser-worker/worker.ts`:

```ts
/**
 * Runs inside a spawned worker thread (see ./pool.ts) — the actual
 * node-html-parser/papaparse/fast-xml-parser calls happen here, off the
 * main event loop, so a pathological input can only ever hang this one
 * disposable thread. `parentPort` is null when this file is imported
 * directly (e.g. by worker.test.ts), so the message-wiring block below is
 * a no-op in that context — the exported functions are plain, directly
 * testable without spinning up a thread.
 */
import { parentPort } from "node:worker_threads";
import { parse as parseHtmlDom } from "node-html-parser";
import Papa from "papaparse";
import { XMLParser } from "fast-xml-parser";
import { boundedJson } from "../bounded-json.js";
import { BRIDGE_RESULT_BYTES, HTML_LINKS_LIMIT } from "../limits.js";

export function parseHtmlPayload(html: string): { title: string | null; text: string; links: { href: string; text: string }[] } {
  const root = parseHtmlDom(html);
  const title = root.querySelector("title")?.text?.trim() ?? null;
  const text = root.text.replace(/\s+/g, " ").trim();
  const anchors = root.querySelectorAll("a[href]");
  if (anchors.length > HTML_LINKS_LIMIT) throw new Error("html_link_limit");
  const links: { href: string; text: string }[] = [];
  let remaining = BRIDGE_RESULT_BYTES - Buffer.byteLength(boundedJson({ title, text, links }, BRIDGE_RESULT_BYTES));
  // Nested anchors can repeat the same text; bound expansion during extraction.
  for (const a of anchors) {
    const link = { href: a.getAttribute("href") ?? "", text: a.text.trim() };
    remaining -= Buffer.byteLength(boundedJson(link, remaining)) + 1;
    if (remaining < 0) throw new Error("bridge_size_limit");
    links.push(link);
  }
  return { title, text, links };
}

export function parseCsvPayload(csv: string, header: boolean): { data: unknown; errors: unknown; meta: unknown } {
  const result = Papa.parse(csv, { header, skipEmptyLines: true });
  return { data: result.data, errors: result.errors, meta: result.meta };
}

export function parseXmlPayload(xml: string, xmlOptions: Record<string, unknown> | null): unknown {
  const parser = new XMLParser({ ...xmlOptions, processEntities: false });
  return parser.parse(xml);
}

interface ParseRequest {
  kind: "html" | "csv" | "xml";
  payload: { html: string } | { csv: string; header: boolean } | { xml: string; xmlOptions: Record<string, unknown> | null };
}

function handle(request: ParseRequest): unknown {
  if (request.kind === "html") return parseHtmlPayload((request.payload as { html: string }).html);
  if (request.kind === "csv") {
    const { csv, header } = request.payload as { csv: string; header: boolean };
    return parseCsvPayload(csv, header);
  }
  const { xml, xmlOptions } = request.payload as { xml: string; xmlOptions: Record<string, unknown> | null };
  return parseXmlPayload(xml, xmlOptions);
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (request: ParseRequest) => {
    try {
      port.postMessage({ ok: true, value: handle(request) });
    } catch (err) {
      port.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/parser-worker/worker.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add src/sandbox/parser-worker/worker.ts src/sandbox/parser-worker/worker.test.ts
git commit -m "feat(sandbox): extract HTML/CSV/XML parsing into a worker-thread module"
```

---

## Task 3: Build the bounded worker pool (`pool.ts`)

**Files:**
- Create: `src/sandbox/parser-worker/pool.ts`
- Create: `src/sandbox/parser-worker/__fixtures__/echo.ts`
- Create: `src/sandbox/parser-worker/__fixtures__/reject.ts`
- Create: `src/sandbox/parser-worker/__fixtures__/spin-forever.ts`
- Create: `src/sandbox/parser-worker/__fixtures__/crash.ts`
- Create: `src/sandbox/parser-worker/pool.test.ts`

**Interfaces:**
- Consumes: `PARSER_WORKER_MAX_CONCURRENCY`, `PARSER_WORKER_QUEUE_LIMIT`, `PARSER_WORKER_TIMEOUT_MS`, `PARSER_WORKER_MAX_OLD_GEN_MB` (Task 1, `../limits.js`).
- Produces: `export type ParserKind = "html" | "csv" | "xml"`, `export interface ParserWorkerPool { run(kind: ParserKind, payload: unknown, signal?: AbortSignal): Promise<unknown>; }`, `export interface ParserWorkerPoolOptions { maxConcurrency?: number; timeoutMs?: number; maxOldGenerationSizeMb?: number; queueLimit?: number; workerUrl?: URL }`, `export function createParserWorkerPool(options?: ParserWorkerPoolOptions): ParserWorkerPool` — consumed by Task 4's `host-functions.ts`.

- [x] **Step 1: Write the fixture workers and the failing tests**

Create `src/sandbox/parser-worker/__fixtures__/echo.ts`:

```ts
import { parentPort } from "node:worker_threads";
if (parentPort) {
  const port = parentPort;
  port.on("message", (request: unknown) => port.postMessage({ ok: true, value: request }));
}
```

Create `src/sandbox/parser-worker/__fixtures__/reject.ts`:

```ts
import { parentPort } from "node:worker_threads";
if (parentPort) {
  const port = parentPort;
  port.on("message", () => port.postMessage({ ok: false, message: "fixture_reject" }));
}
```

Create `src/sandbox/parser-worker/__fixtures__/spin-forever.ts`:

```ts
import { parentPort } from "node:worker_threads";
if (parentPort) {
  parentPort.on("message", () => {
    // Simulates a pathological synchronous parse that never yields — this
    // is what proves the pool's timeout can reclaim a genuinely hung
    // worker, without depending on any real library's specific behavior.
    let i = 0;
    while (true) i++;
  });
}
```

Create `src/sandbox/parser-worker/__fixtures__/crash.ts`:

```ts
import { parentPort } from "node:worker_threads";
if (parentPort) {
  parentPort.on("message", () => {
    throw new Error("fixture_crash");
  });
}
```

Create `src/sandbox/parser-worker/pool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createParserWorkerPool } from "./pool.js";

const fixture = (name: string) => new URL(`./__fixtures__/${name}.ts`, import.meta.url);

describe("createParserWorkerPool", () => {
  it("resolves with the worker's success response", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("echo") });
    await expect(pool.run("html", { hello: "world" })).resolves.toEqual({ kind: "html", payload: { hello: "world" } });
  });

  it("rejects with the worker's reported error", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("reject") });
    await expect(pool.run("csv", {})).rejects.toThrow("fixture_reject");
  });

  it("terminates a hung worker at the timeout instead of hanging forever", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("spin-forever"), timeoutMs: 200 });
    const start = Date.now();
    await expect(pool.run("xml", {})).rejects.toThrow("parser_timeout");
    expect(Date.now() - start).toBeLessThan(2000);
  }, 5000);

  it("surfaces a crashing worker as parser_worker_crashed and stays usable afterwards", async () => {
    const crashPool = createParserWorkerPool({ workerUrl: fixture("crash") });
    await expect(crashPool.run("html", {})).rejects.toThrow("parser_worker_crashed");
    const echoPool = createParserWorkerPool({ workerUrl: fixture("echo") });
    await expect(echoPool.run("html", { x: 1 })).resolves.toEqual({ kind: "html", payload: { x: 1 } });
  });

  it("rejects fast once maxConcurrency + queueLimit is exceeded", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("spin-forever"), timeoutMs: 300, maxConcurrency: 1, queueLimit: 1 });
    const first = pool.run("html", {}); // occupies the one worker slot
    const second = pool.run("html", {}); // fills the one queue slot
    const third = pool.run("html", {}); // must be rejected immediately, no slot or queue room left
    await expect(third).rejects.toThrow("parser_pool_saturated");
    await Promise.allSettled([first, second]); // let the two timeouts drain before the test ends
  }, 3000);

  it("rejects immediately on an already-aborted signal without spawning a worker", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("spin-forever") });
    const controller = new AbortController();
    controller.abort();
    await expect(pool.run("html", {}, controller.signal)).rejects.toThrow("parser_aborted");
  });

  it("terminates a worker when the caller's signal aborts mid-call", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("spin-forever"), timeoutMs: 5000 });
    const controller = new AbortController();
    const call = pool.run("html", {}, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    await expect(call).rejects.toThrow("parser_aborted");
    expect(Date.now() - start).toBeLessThan(2000);
  }, 5000);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sandbox/parser-worker/pool.test.ts`
Expected: FAIL — `Cannot find module './pool.js'`.

- [x] **Step 3: Write `pool.ts`**

Create `src/sandbox/parser-worker/pool.ts`:

```ts
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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/parser-worker/pool.test.ts`
Expected: PASS (7 tests). The timeout/abort tests take a few hundred ms each; total file should finish in well under 10s.

- [x] **Step 5: Commit**

```bash
git add src/sandbox/parser-worker/pool.ts src/sandbox/parser-worker/pool.test.ts src/sandbox/parser-worker/__fixtures__
git commit -m "feat(sandbox): add bounded worker pool for parser isolation"
```

---

## Task 4: Wire `host-functions.ts` to the pool

**Files:**
- Modify: `src/sandbox/host-functions.ts`

**Interfaces:**
- Consumes: `createParserWorkerPool`, `ParserWorkerPool` (Task 3, `./parser-worker/pool.js`).

- [x] **Step 1: Remove the direct parser-library imports and update the `limits.js` import**

In `src/sandbox/host-functions.ts`, replace:

```ts
import { parse as parseHtml } from "node-html-parser";
import Papa from "papaparse";
import { XMLParser } from "fast-xml-parser";
```

with:

```ts
import { createParserWorkerPool, type ParserWorkerPool } from "./parser-worker/pool.js";
```

And replace the `limits.js` import line:

```ts
import { PARSER_INPUT_BYTES, HTML_LINKS_LIMIT, BRIDGE_RESULT_BYTES, RANDOM_BYTES_LIMIT, LOG_BYTES, WALL_TIME_LIMIT_MS } from "./limits.js";
```

with:

```ts
import { PARSER_INPUT_BYTES, RANDOM_BYTES_LIMIT, LOG_BYTES, WALL_TIME_LIMIT_MS } from "./limits.js";
```

(`HTML_LINKS_LIMIT` and `BRIDGE_RESULT_BYTES` moved into `worker.ts` in Task 2 and are no longer used directly in this file.)

- [x] **Step 2: Add the `parserPool` option and module-level default**

Add to `HostFunctionOptions` (after the existing `logger?: Logger;` field):

```ts
  /** Overrides the shared default parser-worker pool — mainly for tests. */
  parserPool?: ParserWorkerPool;
```

Add near the top of the file, alongside `const FETCH_ALLOWED_HOSTS = ...`:

```ts
let sharedParserPool: ParserWorkerPool | undefined;
```

Inside `installHostFunctions`, right after the existing `const sandboxLog = ...` line, add:

```ts
  const parserPool = options.parserPool ?? (sharedParserPool ??= createParserWorkerPool());
```

- [x] **Step 3: Replace the three parser bridge handlers**

Replace the bodies of `__bridge_parseHTML`, `__bridge_parseCSV`, and `__bridge_parseXML` with:

```ts
  register("__bridge_parseHTML", async (argsJson) => {
    const [html] = args<[string]>(argsJson);
    boundedString(html, PARSER_INPUT_BYTES);
    return parserPool.run("html", { html }, signal);
  });

  register("__bridge_parseCSV", async (argsJson) => {
    const [csv, csvOptions] = args<[string, { header?: boolean } | null]>(argsJson);
    boundedString(csv, PARSER_INPUT_BYTES);
    return parserPool.run("csv", { csv, header: csvOptions?.header ?? true }, signal);
  });

  register("__bridge_parseXML", async (argsJson) => {
    const [xml, xmlOptions] = args<[string, Record<string, unknown> | null]>(argsJson);
    boundedString(xml, PARSER_INPUT_BYTES);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("xml_entities_blocked");
    if (xmlOptions && Object.entries(xmlOptions).some(([key, value]) => !["ignoreAttributes", "trimValues", "parseTagValue"].includes(key) || typeof value !== "boolean")) throw new Error("xml_options_invalid");
    return parserPool.run("xml", { xml, xmlOptions }, signal);
  });
```

The cheap pre-checks (size bound, DOCTYPE/ENTITY regex, options allowlist) stay on the main thread exactly as before — they're pure and fast, so failing input never even reaches a worker.

- [x] **Step 4: Run the existing sandbox test suite to confirm no regression**

Run: `npx vitest run src/sandbox/host-functions.test.ts src/sandbox/run-in-sandbox.test.ts`
Expected: PASS, all existing assertions unchanged — including the size-limit `it.each` (line 38), the `html_link_limit` test (line 51), and the XML entity-blocking tests. These now flow through the real pool end-to-end; passing unchanged is the regression proof for the wiring.

**Execution note (real bug found and fixed here, not anticipated during scoping):** this step initially FAILED — `bounds HTML link extraction before constructing an amplified result` reported `parser_worker_crashed: Cannot find module '.../bounded-json.js' imported from .../worker.ts`. Root cause: the scoping session's verification that a `.ts` worker loads correctly under vitest only tested a worker with zero sibling imports. The real `worker.ts` imports `../bounded-json.js`/`../limits.js` (NodeNext ".js"-specifier-resolves-to-".ts" convention). That remapping is a `tsx`-loader feature; a worker thread spawned from a vitest-run process does NOT inherit a tsx loader via `process.execArgv` (only a `tsx`-launched parent, e.g. the `cli` script, has one to inherit) — so the nested import was resolved by Node's own native module loader, which found no literal `bounded-json.js` file. Fixed in `pool.ts` by explicitly passing `execArgv: ["--import", "tsx/esm"]` whenever the resolved worker URL ends in `.ts`; the compiled-`.js` production path is untouched (no loader needed there). Re-verified against a raw `node -e` spawn of the real `worker.ts`, against the full `host-functions.test.ts`/`run-in-sandbox.test.ts` suites under vitest, and against the compiled `dist/sandbox/parser-worker/worker.js` — all three pass.

- [x] **Step 5: Commit**

```bash
git add src/sandbox/host-functions.ts src/sandbox/parser-worker/pool.ts
git commit -m "refactor(sandbox): route HTML/CSV/XML parsing through the worker pool"
```

---

## Task 5: End-to-end happy-path coverage, full suite, and docs

The existing `host-functions.test.ts` only exercises the oversized/malformed rejection paths for these three parsers at the `runInSandbox` layer — there's no happy-path (valid, successful) integration test for CSV or XML there today. Add one for each to prove the new worker-thread relay (structured-clone across `postMessage`, etc.) doesn't break normal usage end-to-end.

**Files:**
- Modify: `src/sandbox/host-functions.test.ts`
- Modify: memory file `reevo_run_code_review_findings.md` (outside the repo, in the user's memory store)

- [ ] **Step 1: Add happy-path integration tests**

Add to `src/sandbox/host-functions.test.ts` (near the existing `bounds HTML link extraction` test):

```ts
  it("parses valid CSV end-to-end through the worker pool", async () => {
    const result = await runInSandbox({ code: "return await parseCSV('a,b\\n1,2');", params: {}, agentId: "a", datastore: fakeDatastore(), toolName: "csv-smoke" });
    expect(result).toMatchObject({ ok: true, value: { data: [{ a: "1", b: "2" }] } });
  });

  it("parses valid XML end-to-end through the worker pool", async () => {
    const result = await runInSandbox({ code: "return await parseXML('<x>hi</x>');", params: {}, agentId: "a", datastore: fakeDatastore(), toolName: "xml-smoke" });
    expect(result).toMatchObject({ ok: true, value: { x: "hi" } });
  });

  it("parses valid HTML end-to-end through the worker pool", async () => {
    const result = await runInSandbox({ code: "return await parseHTML('<title>T</title><a href=\"/x\">L</a>');", params: {}, agentId: "a", datastore: fakeDatastore(), toolName: "html-smoke" });
    expect(result).toMatchObject({ ok: true, value: { title: "T", links: [{ href: "/x", text: "L" }] } });
  });
```

(Check the exact shape `runInSandbox` wraps a successful result in — match whatever the existing passing tests in this file already assert for the `ok: true` case, e.g. `result.ok` / `result.value` field names, before finalizing this step.)

- [ ] **Step 2: Run the full test suite and build**

Run: `npm test`
Expected: all tests pass (536 existing + this plan's new ones).

Run: `npm run build`
Expected: clean build — confirms `tsc -p tsconfig.build.json` compiles `worker.ts`/`pool.ts`/fixtures into `dist/sandbox/parser-worker/` correctly (no special vendor-style build step needed; they're picked up by the existing `"include": ["src/**/*.ts"]` glob).

No Prisma drift check is needed for this task — nothing here touches `schema.prisma` or migrations.

- [ ] **Step 3: Update the review-findings memory**

Update `reevo_run_code_review_findings.md`: move "HTML/CSV/XML parsers process fully attacker-controlled content" from "Still open" to "Also fixed" once this plan is fully implemented and its tests pass, noting the worker-pool isolation approach, the spawn-per-call design decision (D1), and that D2 (the `maxOldGenerationSizeMb` memory cap) was independently verified against a realistic JS-heap allocation bomb and confirmed sufficient for these three parsers.

- [ ] **Step 4: Commit**

```bash
git add src/sandbox/host-functions.test.ts
git commit -m "test(sandbox): add HTML/CSV/XML happy-path coverage through the worker pool"
```

---

## Self-Review

**Spec coverage:** D1 (spawn-per-call design) → Task 3. D2 (memory limit, left open) → called out in Global Constraints and Task 3's docstring, not silently resolved. The core threat (host-process CPU-time DoS via a hung synchronous parse) → Task 3's `spin-forever` fixture tests, which directly exercise the `terminate()`-on-timeout guarantee this whole plan exists for. Regression safety for existing behavior → Task 4 Step 4 and Task 5's happy-path tests.

**Placeholder scan:** Task 5 Step 1 has one explicit call-out ("check the exact shape... before finalizing") rather than a vague TODO — it names precisely what to check and against what (the file's own existing passing assertions), so the executor isn't guessing at an unspecified detail; treat it as a five-minute verification against real file content, not an open design question.

**Type consistency:** `ParserWorkerPool.run(kind, payload, signal)` (Task 3) matches its two call sites in Task 4 exactly (`parserPool.run("html", { html }, signal)`, etc.). `ParseRequest`'s `kind`/`payload` shape in `worker.ts` (Task 2) matches what `pool.ts` (Task 3) sends via `postMessage({ kind, payload })`.
