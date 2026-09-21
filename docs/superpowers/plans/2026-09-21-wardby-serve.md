# `wardby serve` — One-Process Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give wardby a single `wardby serve` process that runs the MCP server, the scheduler, and the reconciler together, so a Cloud Run deployment actually fires scheduled agents instead of silently accepting schedules it never runs.

**Architecture:** No scheduling logic changes. `startServe()` builds the provider set once (satisfying the DBOS one-executor-per-process singleton), hands that single executor to `startMcp()`, `startScheduler()`, and `startReconciler()`, and stops them in the right order on shutdown. The Docker image's default CMD becomes `serve`; the GCP module additionally sets `cpu_idle = false`, without which Cloud Run starves every `setInterval` in the process — including run heartbeats, which the newly-attached reconciler would then reap. Those two deploy changes are one change.

**Tech Stack:** TypeScript/Node 22, Prisma 6 + PostgreSQL, DBOS (durable executor), Vitest, Terraform (`hashicorp/google ~> 8.3`), Cloud Run v2.

**Spec:** No separate spec document. This plan is synthesized from a code review of the scheduler, reconciler, lease, dispatch, and both CLI entry points on 2026-09-21 (findings in **Background** below), following a live finding that the GCP deployment never fires schedules. The GCP module itself is `deploy/gcp/` (design: `docs/superpowers/specs/2026-09-17-gcp-control-plane-hosting-design.md`); the roadmap entry that anticipated hosted deployments is `docs/private/2026-09-05-roadmap-mcp-native.md` (Phase 12).

## Background — what the review established

Every task below rests on these facts; an implementer should not have to rediscover them.

- **`wardby mcp` never runs the scheduler.** `startScheduler`/`startReconciler` are called only inside `cli.ts`'s `scheduler()` command. `deploy/Dockerfile:28` runs `mcp`, and `deploy/gcp/cloud-run.tf` does not override it — so scheduled agents on GCP sit at `scheduleEnabled: true` with `lastScheduledAt: null` forever. (Verified structurally; Friday's live "scheduler test" only worked because a second local process was started by hand.)
- **The two-process model was known but undocumented.** `deploy/production/compose.yml` runs separate `mcp` and `scheduler` containers with distinct `DBOS_EXECUTOR_ID`s. Nothing in `README.md` or `docs/*.md` says a complete deployment needs both; `README.md` line 60 ("`wardby mcp` exposes agents, tools, scheduling, runs…") reads as though `mcp` schedules. It exposes the _management_ tools for schedules.
- **Multi-instance is the designed topology.** `src/core/scheduler.ts` header: at-most-once is enforced by `claimDueRun`'s `FOR UPDATE SKIP LOCKED` plus advancing `lastScheduledAt` in the same transaction as the `Run` insert — "never by the lease alone." The lease only stops redundant ticking. `src/core/reconciler.ts` is explicitly _not_ lease-gated ("Any instance … periodically transitions such runs") and is made concurrency-safe by conditional `updateMany`. Running both in every replica of a `min_instance_count = 2` service is what the code was written for.
- **One executor per process.** `DbosExecutor.launch()` (`src/providers/executor/dbos.ts:127-155`) throws if DBOS is already initialized under a different executor id, because `recover()`'s ownership decisions key on `DBOS.executorID`. `startMcp()` builds its own executor (`src/mcp/index.ts:156`) and `scheduler()` builds another (`src/cli.ts:510-512`); composing them naively throws at boot. `serve` must build once and share.
- **Executor ids are safe across replicas.** `loadDbosConfig()` (`src/config/providers.ts`) defaults `executorId` to a fresh UUID per process when `DBOS_EXECUTOR_ID` is unset, written expressly so replicas of a scaled Cloud Run service never share an identity. No plan work needed; do not set `DBOS_EXECUTOR_ID` in the GCP module.
- **A pre-existing bug that unification fixes.** `buildMcpProviders()` patches `nativeProviders.executor = executor` so a native run can dispatch a coding-kind sub-agent; `cli.ts scheduler()` builds providers without that patch. A _scheduled_ native run delegating to a coding sub-agent therefore gets `coding_dispatch_unavailable` (`src/core/runner.ts:379`) while the same agent triggered over MCP works. Building providers once via `buildMcpProviders()` closes it.
- **CPU throttling reaps live runs, not just schedules.** `deploy/gcp/cloud-run.tf` sets no `resources`, so the provider default `cpu_idle = true` applies: CPU is allocated only while a request is in flight. `InProcessExecutor` beats `heartbeatAt` on a 10s `setInterval` (`src/providers/executor/in-process.ts:30`); the reconciler reaps anything silent for 45s (`HEARTBEAT_TIMEOUT_MS`). Today no reconciler runs on GCP, so a starved heartbeat is harmless. `serve` adds one — so `serve` under throttling means replica B marks replica A's healthy run `lost`. `cpu_idle = false` ships in the same task as the CMD change, never separately.
- **The startup warning shipped on 2026-09-20 (`ccc396d`) becomes a false alarm.** `warnIfNothingWillFireSchedules()` in `startMcp()` fires whenever enabled schedules exist. Under `serve` a scheduler _is_ attached. `startMcp` needs to be told.
- **stdio is out.** `cli.ts scheduler()` logs with `console.log` (stdout). In stdio transport stdout _is_ the JSON-RPC wire (`cli.ts mcp()` documents exactly this hazard). `serve` refuses `MCP_TRANSPORT=stdio`.
- **Shutdown order.** Cloud Run sends `SIGTERM` with a 10s default grace; `DBOS.shutdown` waits up to 5s for workflows (`dbos.ts:159`). Stop accepting new schedule claims first, then the reconciler, then HTTP, then the executor.

## Global Constraints

- **Never commit to `main`.** Work on `gcp-deploy-followups` (current branch) or a new branch.
- **This is a self-hosted project — no CI/CD pipeline.** No GitHub Actions or automated-deploy tooling; deployment steps stay manual and documented in `deploy/gcp/SETUP.md`.
- **CLAUDE.md "Deployment (deploy/) — STRICT":** no target-specific identity hardcoded in any committed module file; never commit a filled-in `*.tfvars`, real resource IDs, or `.terraform/` state.
- **CLAUDE.md "Database / Prisma — STRICT"** is **not applicable**: this plan touches no `schema.prisma` or migration files, so no drift check is required.
- **No scheduling-logic changes.** `src/core/scheduler.ts`, `src/core/reconciler.ts`, `src/core/lease.ts`, `src/core/dispatch.ts`, and `src/core/cron.ts` are not modified by this plan. Their tests must keep passing untouched.
- **`cpu_idle = false` and the Dockerfile CMD change land in the same commit** (Task 4). Shipping either alone is worse than shipping neither (see Background).
- App-code tasks verify with `npm test`, `npm run typecheck`, and `npm run lint`. Database-backed tests are gated with `describe.skipIf(!process.env.DATABASE_URL)`; run them with local Postgres up (`npm run db:up`) — `vitest.setup.ts` loads `.env.local`, which supplies `DATABASE_URL`.
- Terraform tasks verify with `terraform fmt -check` and `terraform validate`; a live `plan`/`apply` is a manual, human-triggered step.
- Commit messages end with the session's attribution trailers:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4`.

## File structure

| File                                        | Responsibility                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp/unattended-schedules.ts` (new)     | The "schedules exist but nothing will fire them" check, as two small functions with no logger or `process` coupling, so it is testable and reusable. |
| `src/mcp/index.ts` (modify)                 | `startMcp()` gains `StartMcpOptions` — inject pre-built providers, and declare that a scheduler is attached. Uses the new module for the warning.    |
| `src/serve.ts` (new)                        | `startServe()` — the composition root: one provider set, one executor, MCP + scheduler + reconciler, ordered shutdown, refuses stdio.                |
| `src/cli.ts` (modify)                       | The `wardby serve` command: `--scope`, one signal handler, stderr-only output.                                                                       |
| `deploy/Dockerfile` (modify)                | Default CMD becomes `serve`.                                                                                                                         |
| `deploy/gcp/cloud-run.tf` (modify)          | `resources { cpu_idle = false }` on the container.                                                                                                   |
| `README.md`, `deploy/gcp/SETUP.md` (modify) | State the process model: `serve` is complete; `mcp` + `scheduler` is the split alternative.                                                          |
| `deploy/production/compose.yml`             | **Unchanged.** It overrides `command` for both containers and already runs the split model correctly.                                                |

---

### Task 1: Make `startMcp()` injectable and scheduler-aware

**Files:**

- Create: `src/mcp/unattended-schedules.ts`
- Create: `src/mcp/unattended-schedules.test.ts`
- Modify: `src/mcp/index.ts` (the `warnIfNothingWillFireSchedules` function added in `ccc396d`, and `startMcp()` at line 154)

**Interfaces:**

- Consumes: `prisma` from `src/core/db.ts`; `McpProviders` from `src/mcp/context.ts` (`Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets" | "executor" | "memory">`); `buildMcpProviders()` (existing, unchanged).
- Produces:
  - `countUnattendedSchedules(db: Pick<PrismaClient, "agent">): Promise<number>`
  - `unattendedSchedulesWarning(count: number): string | null`
  - `interface StartMcpOptions { providers?: McpProviders; schedulerAttached?: boolean }`
  - `startMcp(options?: StartMcpOptions): Promise<McpServerHandle>` — same return type as today. Task 2 calls it as `startMcp({ providers, schedulerAttached: true })`.

- [ ] **Step 1: Write the failing tests**

Create `src/mcp/unattended-schedules.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { countUnattendedSchedules, unattendedSchedulesWarning } from "./unattended-schedules.js";

describe("unattendedSchedulesWarning", () => {
  it("is silent at zero and names both remedies otherwise", () => {
    expect(unattendedSchedulesWarning(0)).toBeNull();
    const msg = unattendedSchedulesWarning(2);
    expect(msg).toMatch(/^2 agent\(s\)/);
    expect(msg).toContain('"wardby scheduler"');
    expect(msg).toContain('"wardby serve"');
  });
});

describe.skipIf(!process.env.DATABASE_URL)("countUnattendedSchedules (database)", () => {
  const db = new PrismaClient();
  const names: string[] = [];
  afterAll(async () => {
    await db.agent.deleteMany({ where: { name: { in: names } } });
    await db.$disconnect();
  });

  it("counts only agents whose schedule is enabled and non-null", async () => {
    // Relative assertions: the shared local database may hold other enabled agents.
    const baseline = await countUnattendedSchedules(db);
    const enabled = "unattended-on-" + randomUUID();
    const disabled = "unattended-off-" + randomUUID();
    const unscheduled = "unattended-none-" + randomUUID();
    names.push(enabled, disabled, unscheduled);
    const base = { systemPrompt: "x", model: "gpt-4.1-nano", budgetUsd: 1 };
    await db.agent.create({ data: { ...base, name: enabled, schedule: "*/5 * * * *", scheduleEnabled: true } });
    await db.agent.create({ data: { ...base, name: disabled, schedule: "*/5 * * * *", scheduleEnabled: false } });
    await db.agent.create({ data: { ...base, name: unscheduled, schedule: null, scheduleEnabled: true } });

    expect(await countUnattendedSchedules(db)).toBe(baseline + 1);

    await db.agent.update({ where: { name: enabled }, data: { scheduleEnabled: false } });
    expect(await countUnattendedSchedules(db)).toBe(baseline);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run db:up && npx vitest run src/mcp/unattended-schedules.test.ts`
Expected: FAIL — `Cannot find module './unattended-schedules.js'`.

- [ ] **Step 3: Create the module**

Create `src/mcp/unattended-schedules.ts`:

```typescript
import type { PrismaClient } from "@prisma/client";

/**
 * `wardby mcp` serves the MCP surface and launches the executor, but the
 * scheduler and reconciler live in `wardby scheduler` (or in `wardby serve`,
 * which runs everything). A deployment running only `mcp` accepts schedules
 * through set_schedule and then never fires them: no error, no crash,
 * `lastScheduledAt` simply stays null. Nothing else surfaces that.
 *
 * Kept free of logging and process state so it can be unit-tested and reused
 * by any composition root.
 */

/** Same predicate the scheduler uses to find candidates (core/scheduler.ts). */
export async function countUnattendedSchedules(db: Pick<PrismaClient, "agent">): Promise<number> {
  return db.agent.count({ where: { scheduleEnabled: true, schedule: { not: null } } });
}

/** The warning to log for `count` unattended schedules, or null when there is nothing to warn about. */
export function unattendedSchedulesWarning(count: number): string | null {
  if (count === 0) return null;
  return (
    `${count} agent(s) have an enabled schedule, but this process does not run the scheduler. ` +
    `Run "wardby scheduler" alongside it, or run "wardby serve" instead, or those schedules will never fire.`
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/mcp/unattended-schedules.test.ts`
Expected: PASS (2 tests; the database one runs because `.env.local` supplies `DATABASE_URL`).

- [ ] **Step 5: Rewire `startMcp()`**

In `src/mcp/index.ts`, add the import near the other `./` imports:

```typescript
import { countUnattendedSchedules, unattendedSchedulesWarning } from "./unattended-schedules.js";
```

Replace the whole `warnIfNothingWillFireSchedules` function (added in `ccc396d`, just below `SELF_HOSTED_CLEANUP_INTERVAL_MS`) with:

```typescript
async function warnIfNothingWillFireSchedules(): Promise<void> {
  try {
    const message = unattendedSchedulesWarning(await countUnattendedSchedules(prisma));
    if (message) mcpLog.warn(message);
  } catch (err) {
    // Advisory only - never let it stop the server coming up.
    mcpLog.debug({ err }, "could not check for unattended schedules");
  }
}
```

Add the options type directly above `startMcp` (after the `McpServerHandle` interface):

```typescript
export interface StartMcpOptions {
  /**
   * A pre-built provider set. `wardby serve` builds one and shares it, because
   * DbosExecutor is a per-process singleton and two executors cannot coexist
   * (dbos.ts launch()). Built internally when omitted.
   */
  providers?: McpProviders;
  /**
   * Set by a composition root that also runs the scheduler, so startup does
   * not warn that enabled schedules will never fire.
   */
  schedulerAttached?: boolean;
}
```

Change the signature and the first lines of `startMcp` from:

```typescript
export async function startMcp(): Promise<McpServerHandle> {
  const mcpConfig = loadMcpConfig();
  const { providers } = buildMcpProviders();
  await providers.executor.launch?.();
  await warnIfNothingWillFireSchedules();
```

to:

```typescript
export async function startMcp(options: StartMcpOptions = {}): Promise<McpServerHandle> {
  const mcpConfig = loadMcpConfig();
  const providers = options.providers ?? buildMcpProviders().providers;
  await providers.executor.launch?.();
  if (!options.schedulerAttached) await warnIfNothingWillFireSchedules();
```

Nothing else in the function changes: every later use of `providers` is unchanged, and `DbosExecutor.launch()` is idempotent on the same instance (`if (this.launched) return;`), so an injected, already-launched executor is safe.

- [ ] **Step 6: Typecheck, lint, and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; 1137 existing tests plus the 2 new ones. (`McpProviders` is already imported in `index.ts` as `import type { McpProviders } from "./context.js";` — verify with `grep -n 'McpProviders' src/mcp/index.ts`; add the import if it is missing.)

- [ ] **Step 7: Commit**

```bash
git add src/mcp/unattended-schedules.ts src/mcp/unattended-schedules.test.ts src/mcp/index.ts
git commit -m "$(cat <<'EOF'
refactor(mcp): make startMcp injectable and scheduler-aware

Groundwork for `wardby serve`, which runs the MCP server, scheduler, and
reconciler in one process. DbosExecutor is a per-process singleton -
launch() throws if a second executor with a different id appears - so a
combined process must build the provider set once and share it. startMcp
now accepts that set instead of always building its own.

It also accepts schedulerAttached, so the unattended-schedules warning
from ccc396d does not fire as a false alarm when a scheduler genuinely is
running in the same process. The check itself moves to a small module
with no logger or process coupling, so it is unit-tested for the first
time; the warning now also names `wardby serve` as a remedy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 2: `startServe()` — the composition root

**Files:**

- Create: `src/serve.ts`
- Create: `src/serve.test.ts`

**Interfaces:**

- Consumes: `startMcp(options: StartMcpOptions)` and `buildMcpProviders()` from `src/mcp/index.ts` (Task 1); `startScheduler({ executor, db?, scope? }): SchedulerHandle` (`stop()`, `isLeader()`) from `src/core/scheduler.ts`; `startReconciler({ db?, executor? }): ReconcilerHandle` (`stop()`) from `src/core/reconciler.ts`; `loadMcpConfig()` from `src/config/providers.ts`; `McpProviders` from `src/mcp/context.ts`.
- Produces:
  - `interface ServeOptions { scope?: string; providers?: McpProviders }`
  - `interface ServeHandle { close(): Promise<void>; isLeader(): boolean }`
  - `startServe(options?: ServeOptions): Promise<ServeHandle>` — Task 3's CLI command calls this.

- [ ] **Step 1: Write the failing tests**

Create `src/serve.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Executor } from "./providers/executor/types.js";
import type { McpProviders } from "./mcp/context.js";
import { startServe } from "./serve.js";

const ENV_KEYS = [
  "MCP_TRANSPORT",
  "MCP_HTTP_BIND",
  "MCP_CANONICAL_URI",
  "AUTH_PROVIDER",
  "AUTH_AUDIENCE",
  "AUTH_SIGNING_KEY",
  "AUTH_CREDENTIAL_HASH_KEY",
  "SECRET_APP_KEY",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const fakeExecutor: Executor = { async start() {}, async stop() {} };
// startMcp only touches providers.executor at startup; the scheduler and
// reconciler only need start/stop. Everything else is unused for this test.
const providers = { executor: fakeExecutor } as McpProviders;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function until(pred: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("startServe transport guard", () => {
  it("refuses stdio, whose stdout is the JSON-RPC wire", async () => {
    process.env.MCP_TRANSPORT = "stdio";
    await expect(startServe({ providers })).rejects.toThrow(/MCP_TRANSPORT=http/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("startServe (database)", () => {
  const db = new PrismaClient();
  const scope = "serve-test-" + randomUUID();
  afterAll(async () => {
    await db.schedulerLease.deleteMany({ where: { scope } });
    await db.$disconnect();
  });

  it("runs MCP, scheduler, and reconciler on one executor and shuts down cleanly", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    Object.assign(process.env, {
      MCP_TRANSPORT: "http",
      MCP_HTTP_BIND: `127.0.0.1:${port}`,
      MCP_CANONICAL_URI: origin,
      AUTH_PROVIDER: "self-hosted",
      AUTH_AUDIENCE: origin,
      AUTH_SIGNING_KEY: "a1".repeat(32),
      AUTH_CREDENTIAL_HASH_KEY: "b2".repeat(32),
      SECRET_APP_KEY: "c3".repeat(32),
    });

    const handle = await startServe({ providers, scope });
    try {
      // Scheduler: acquires the lease for our private scope almost immediately.
      expect(await until(() => handle.isLeader())).toBe(true);
      const lease = await db.schedulerLease.findUnique({ where: { scope } });
      expect(lease).not.toBeNull();
      expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // MCP: the HTTP transport is up and enforcing auth.
      const res = await fetch(origin + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }

    // Shutdown: the port is released.
    await expect(fetch(origin + "/mcp", { method: "POST" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/serve.test.ts`
Expected: FAIL — `Cannot find module './serve.js'`.

- [ ] **Step 3: Create the composition root**

Create `src/serve.ts`:

```typescript
/**
 * `wardby serve`: the complete wardby process. Runs the MCP server, the
 * scheduler, and the reconciler together on ONE provider set and ONE
 * executor, which is what a single-container deployment (Cloud Run, a lone
 * VM) needs - `wardby mcp` alone never fires a schedule.
 *
 * Why one executor: DbosExecutor is a per-process singleton and refuses to
 * launch twice under different ids (providers/executor/dbos.ts), and its
 * recovery decisions key on that id. Building providers once and sharing
 * them is the whole trick; it also gives scheduled native runs the same
 * `providers.executor` wiring MCP-triggered runs get, so sub-agent dispatch
 * from a scheduled run works (it does not from `wardby scheduler`).
 *
 * Why the scheduler and reconciler can run in every replica: the scheduler
 * elects one ticker via a Postgres lease and enforces at-most-once with row
 * locks regardless (core/scheduler.ts); the reconciler is deliberately not
 * lease-gated and is safe under concurrency (core/reconciler.ts).
 */
import { loadMcpConfig } from "./config/providers.js";
import { startReconciler } from "./core/reconciler.js";
import { startScheduler } from "./core/scheduler.js";
import type { McpProviders } from "./mcp/context.js";
import { buildMcpProviders, startMcp } from "./mcp/index.js";

export interface ServeOptions {
  /** Scheduler lease scope; defaults to "default" like `wardby scheduler --scope`. */
  scope?: string;
  /** Pre-built providers (tests); built once via buildMcpProviders() when omitted. */
  providers?: McpProviders;
}

export interface ServeHandle {
  /** Stops accepting schedule claims, then reconciling, then closes HTTP and the executor. */
  close(): Promise<void>;
  /** Whether this process currently holds the scheduler lease. */
  isLeader(): boolean;
}

export async function startServe(options: ServeOptions = {}): Promise<ServeHandle> {
  const transport = loadMcpConfig().transport;
  if (transport !== "http") {
    throw new Error(
      `wardby serve requires MCP_TRANSPORT=http (got "${transport}"): in stdio mode stdout is the JSON-RPC wire ` +
        `and a scheduler has no stdio client to serve. Use "wardby mcp" for stdio.`,
    );
  }

  const providers = options.providers ?? buildMcpProviders().providers;
  const mcp = await startMcp({ providers, schedulerAttached: true });
  const reconciler = startReconciler({ executor: providers.executor });
  const scheduler = startScheduler({ executor: providers.executor, scope: options.scope });

  return {
    isLeader: () => scheduler.isLeader(),
    close: async () => {
      // Order matters under a SIGTERM grace period: stop creating new runs,
      // stop reaping, then let startMcp close HTTP and drain the executor.
      scheduler.stop();
      reconciler.stop();
      await mcp.close();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/serve.test.ts`
Expected: PASS (2 tests). If the database test fails on `db.schedulerLease`, check the Prisma model name with `grep -n 'model SchedulerLease' prisma/schema.prisma` — the client accessor is the model name in lowerCamelCase.

- [ ] **Step 5: Run the full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass. `src/core/scheduler.test.ts` and the reconciler tests are unchanged and must still pass.

- [ ] **Step 6: Commit**

```bash
git add src/serve.ts src/serve.test.ts
git commit -m "$(cat <<'EOF'
feat: add startServe, one process for MCP + scheduler + reconciler

`wardby mcp` never fires a schedule: startScheduler/startReconciler are
only reached from the `scheduler` command, and the Docker image's default
CMD is `mcp`. A single-container deployment therefore accepts schedules
and silently never runs them. startServe composes all three on one
provider set and one executor - DbosExecutor is a per-process singleton
and refuses a second id - and stops them in dependency order on shutdown.

Building providers once also fixes a divergence: `wardby scheduler` built
its own set without the executor patched onto nativeProviders, so a
scheduled native run could not dispatch a coding-kind sub-agent while the
same agent triggered over MCP could.

Refuses MCP_TRANSPORT=stdio, whose stdout is the protocol wire.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 3: The `wardby serve` CLI command and the process-model docs

**Files:**

- Modify: `src/cli.ts` (imports at top; add a `serve()` function next to `mcp()` at line 532; the `main()` dispatch at line 592; the usage text at line 611)
- Modify: `README.md` (line 60, the "`wardby mcp` exposes …" paragraph)

**Interfaces:**

- Consumes: `startServe(options: ServeOptions): Promise<ServeHandle>` from `src/serve.ts` (Task 2).
- Produces: the `wardby serve [--scope <s>]` command. Task 4's Dockerfile CMD invokes `dist/cli.js serve`.

- [ ] **Step 1: Add the command**

In `src/cli.ts`, add the import alongside `import { startMcp } from "./mcp/index.js";`:

```typescript
import { startServe } from "./serve.js";
```

Add this function immediately after the existing `mcp()` function (which ends just before `async function importCommand`):

```typescript
async function serve(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { scope: { type: "string" } } });
  const handle = await startServe({ scope: values.scope });
  // stderr, like `mcp`: stdout must stay clean in case a future transport
  // multiplexes it, and this keeps the two commands' output consistent.
  console.error(`wardby serve started (scope "${values.scope ?? "default"}"). Press Ctrl+C to stop.`);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.error("\nwardby serve shutting down...");
      void handle
        .close()
        .catch((err: unknown) => cliLog.warn({ err }, "serve close failed during shutdown"))
        .finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
```

In `main()`, add a branch directly after the `mcp` one:

```typescript
    } else if (command === "mcp") {
      await mcp();
    } else if (command === "serve") {
      await serve(rest);
    } else if (command === "import") {
```

In the usage string in `fail(...)`, add a line directly after the `wardby mcp` line:

```typescript
          "  wardby mcp   (MCP_TRANSPORT=stdio|http selects the transport)\n" +
          "  wardby serve [--scope default]   (mcp + scheduler + reconciler in one process; http only)\n" +
```

Also update the file's header comment (lines 4-13) by adding, after the `wardby mcp` entry:

```typescript
 *   wardby serve [--scope default]   (everything: mcp + scheduler + reconciler; the
 *                                    image's default command, and what a
 *                                    single-container deployment should run)
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: pass.

- [ ] **Step 3: Boot it for real**

With local Postgres up (`npm run db:up`), from the repo root:

```bash
DATABASE_URL="postgresql://wardby:wardby@localhost:55432/wardby" MCP_TRANSPORT=http \
MCP_HTTP_BIND=127.0.0.1:8124 MCP_CANONICAL_URI=http://127.0.0.1:8124 AUTH_AUDIENCE=http://127.0.0.1:8124 \
AUTH_PROVIDER=self-hosted AUTH_SIGNING_KEY=$(printf 'a1%.0s' {1..32}) AUTH_CREDENTIAL_HASH_KEY=$(printf 'b2%.0s' {1..32}) \
SECRET_APP_KEY=$(printf 'c3%.0s' {1..32}) JOB_LAUNCHER=native \
npx tsx src/cli.ts serve > /tmp/serve.log 2>&1 &
P=$!; sleep 15; kill -TERM $P; wait $P 2>/dev/null
grep -E 'wardby serve started|acquired leadership|enabled schedule|shutting down' /tmp/serve.log
```

Expected: `wardby serve started (scope "default")`, an `acquired leadership for scope "default"` scheduler line, then `wardby serve shutting down...` — and **no** "enabled schedule … will never fire" warning, even if enabled schedules exist locally (that is the `schedulerAttached` flag working). `.env.local` supplies the LLM key `buildMcpProviders()` requires.

Then the stdio refusal, which needs no database:

```bash
MCP_TRANSPORT=stdio npx tsx src/cli.ts serve; echo "exit $?"
```

Expected: an error mentioning `MCP_TRANSPORT=http`, exit code 1.

- [ ] **Step 4: Document the process model**

In `README.md`, replace the paragraph at line 60 that begins "`wardby mcp` exposes agents, tools, scheduling, runs, datastore, secrets, and" so that it reads (keep the rest of the paragraph's content after the first sentence):

```markdown
`wardby mcp` exposes agents, tools, schedule management, runs, datastore,
secrets, and
```

and add this new paragraph immediately after that paragraph:

```markdown
**A complete deployment runs more than `mcp`.** `wardby mcp` serves the MCP
surface and launches the executor; the scheduler that fires due agents and
the reconciler that recovers orphaned runs live in `wardby scheduler`. Run
**`wardby serve`** to get all of it in one process — it is the container
image's default command and what a single-container deployment (Cloud Run,
a lone VM) should run. Alternatively run `wardby mcp` and `wardby scheduler`
as two processes, as `deploy/production/compose.yml` does. Running `mcp`
alone logs a warning at startup if schedules exist that nothing will fire.
```

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write README.md && npm run format:check
git add src/cli.ts README.md
git commit -m "$(cat <<'EOF'
feat(cli): add `wardby serve` and document the process model

One command that runs the MCP server, scheduler, and reconciler together,
for deployments that run a single container. Logs to stderr like `mcp`,
takes --scope like `scheduler`, and installs one SIGINT/SIGTERM handler
that closes in dependency order.

The README never said a complete deployment needs two processes, and its
"`wardby mcp` exposes ... scheduling" read as though mcp fires schedules -
it exposes the management tools for them. That gap is how deploy/gcp
came to run `mcp` alone. Now stated plainly, with `serve` as the answer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 4: Deploy `serve` — image CMD and always-allocated CPU, together

**Files:**

- Modify: `deploy/Dockerfile:28`
- Modify: `deploy/gcp/cloud-run.tf` (the `containers { … }` block; add `resources` right after `image = var.container_image`)
- Modify: `deploy/gcp/SETUP.md` (new short section after "11. Using your own identity provider")

**Interfaces:**

- Consumes: the `serve` command (Task 3).
- Produces: nothing consumed by later tasks. `deploy/production/compose.yml` is intentionally untouched — it overrides `command` for both of its containers.

- [ ] **Step 1: Change the image's default command**

In `deploy/Dockerfile`, change line 28 from:

```dockerfile
CMD ["node", "dist/cli.js", "mcp"]
```

to:

```dockerfile
# The complete process: MCP + scheduler + reconciler. A deployment that
# splits them (deploy/production/compose.yml) overrides this per container.
CMD ["node", "dist/cli.js", "serve"]
```

- [ ] **Step 2: Allocate CPU outside requests**

In `deploy/gcp/cloud-run.tf`, inside `containers {`, directly after `image = var.container_image` and before the first `volume_mounts` block, add:

```hcl
      # `serve` runs three setInterval loops (scheduler tick, lease renewal,
      # reconciler) and every in-flight run beats its heartbeat on a fourth.
      # Cloud Run's default cpu_idle = true allocates CPU only while a request
      # is being handled, which starves all of them - and a starved heartbeat
      # is worse than a missed tick, because the reconciler then reaps the
      # perfectly healthy run as lost. Always-allocated CPU costs more per
      # instance-hour than the idle rate; it is the price of running a
      # background worker on Cloud Run at all.
      resources {
        cpu_idle = false
      }
```

- [ ] **Step 3: Document it**

Append to `deploy/gcp/SETUP.md`, after section 11:

```markdown
## 12. What the container runs

The image's default command is `wardby serve`: the MCP server, the scheduler
that fires due agents, and the reconciler that recovers orphaned runs, in one
process. The module does not override it, so scheduled agents fire in this
deployment.

Two consequences of running a background worker on Cloud Run:

- **CPU is always allocated** (`cpu_idle = false` in `cloud-run.tf`). The
  default only gives a container CPU while it handles a request, which
  starves the scheduler's timers and — worse — the heartbeat every running
  agent sends; the reconciler would then reap healthy runs as lost. This is
  billed at a higher rate than idle CPU.
- **Every replica runs all three.** With `min_instance_count = 2`, both
  instances run a scheduler; a Postgres lease elects one to tick and row
  locks make firing at-most-once regardless. Both run the reconciler by
  design. Each instance gets its own DBOS executor id automatically — do not
  set `DBOS_EXECUTOR_ID` here, or replicas would share one.
```

- [ ] **Step 4: Validate Terraform**

Run: `cd deploy/gcp && terraform fmt -check -diff . && terraform validate`
Expected: no diff; `Success! The configuration is valid.`

- [ ] **Step 5: Plan against a live deployment, if one exists (manual)**

If a deployment is currently applied (the clean-room build on `onit-dashboard` was live on 2026-09-21), a plan with the existing variable values should show **exactly one change**: `google_cloud_run_v2_service.main` updated in place, `resources.cpu_idle` `true -> false`. Nothing created, nothing destroyed. The image digest is unchanged at plan time — the new CMD only takes effect after the image is rebuilt and pushed, which is a separate manual step per SETUP.md §7. If no deployment exists, skip this step; Step 4 is the required gate.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write deploy/gcp/SETUP.md && npm run format:check
git add deploy/Dockerfile deploy/gcp/cloud-run.tf deploy/gcp/SETUP.md
git commit -m "$(cat <<'EOF'
feat(deploy): run `serve` by default, with always-allocated CPU on Cloud Run

The image's default command was `mcp`, and deploy/gcp did not override it,
so the GCP deployment never ran the scheduler or reconciler: scheduled
agents were accepted and never fired. The default is now `serve`.
deploy/production/compose.yml already splits mcp and scheduler across two
containers and overrides the command for both, so it is unaffected.

cpu_idle = false lands in the same change on purpose. Cloud Run's default
allocates CPU only during a request, which starves every setInterval in
the process. That already meant missed ticks; with the reconciler now
attached it would mean reaping healthy runs, because their 10s heartbeat
starves too and the reconciler marks anything silent for 45s as lost.
Shipping the CMD change without this would be worse than shipping neither.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Self-review notes

- **Coverage against the Background findings:** no-scheduler-on-GCP → Tasks 2–4; undocumented process model → Task 3 (README) + Task 4 (SETUP); DBOS singleton → Task 1 (injection) + Task 2 (build once); executor-id across replicas → no code, documented in Task 4 SETUP text; sub-agent divergence → Task 2 (build via `buildMcpProviders()`); CPU throttling reaping runs → Task 4, atomic with CMD; false-alarm warning → Task 1 (`schedulerAttached`); stdio → Task 2 guard + test; shutdown order → Task 2 `close()`, Task 3 single handler.
- **Not in scope, deliberately:** moving scheduling into DBOS scheduled workflows (a later, internal-only refactor of what `serve` does — the topology, CMD, and Terraform from this plan survive it); a scheduler-only Cloud Run service (a Cloud Run _service_ must listen on `$PORT`, which `wardby scheduler` does not, so that path needs app changes too and gains nothing over `serve`); changing `deploy/production/compose.yml`.
- **Placeholder scan:** every step has real code, exact paths, and a concrete verification command. Step 5 of Task 4 is conditional on a live deployment existing and says so; Step 4 is the required gate.
- **Name consistency:** `StartMcpOptions` / `schedulerAttached` / `providers` (Task 1) are what Task 2 passes; `startServe` / `ServeOptions` / `ServeHandle` (Task 2) are what Task 3 imports; `countUnattendedSchedules` / `unattendedSchedulesWarning` are used only in Task 1. `handle.isLeader()` in the Task 2 test matches `ServeHandle.isLeader`.
