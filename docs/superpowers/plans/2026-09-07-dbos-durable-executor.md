# DBOS Durable Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `EXECUTOR=dbos`, a second `Executor` adapter that runs each native
agent run as a DBOS durable workflow so a run that dies mid-way (process crash,
deploy, OOM) resumes from its last completed LLM turn or tool call instead of
being reconciled to `lost`, and so `stop` becomes a real cancellation.

**Architecture:** The engine seam gains an optional `step` boundary; the native
engine wraps every non-deterministic side effect (token estimate, LLM turn, tool
call) in it. The in-process executor leaves `step` unset, so nothing changes for
it. `DbosExecutor` registers one DBOS workflow, `wardby.run(runId)`, whose body is
the existing `executeRun` with `step` bound to `DBOS.runStep`. DBOS records each
step's result in its own tables and, on restart, replays completed steps from
the record without re-executing them. A nullable `Run.executionBackend` column
lets the reconciler ask DBOS about a stale run rather than blindly marking it
lost, and lets it adopt a run orphaned by a dead instance via
`DBOS.resumeWorkflow`.

**Tech Stack:** TypeScript (Node 22.12+), `@dbos-inc/dbos-sdk` 4.27.6 (MIT,
in-process, Postgres system tables), Prisma 6, vitest.

**Spec:** `docs/private/2026-09-05-roadmap-mcp-native.md` (Phase 6 entry) and
`docs/private/2026-09-05-phase-2-scheduler-durability-design.md` (sections "The
`Executor` seam (DBOS plug point)", "DBOS-readiness checklist", and "Future
engines: layer boundaries"). The seam contract is
`src/providers/executor/types.ts`.

## As-built notes (2026-09-07)

Implemented on branch `worktree-dbos-durable-executor`. Where the code differs from the task text below, the code is right:

- `duplicationPolicy: "return-existing"` is not passed to `startWorkflow`; in SDK 4.27.6 it is a queue-only option. `workflowID = runId` alone is idempotent.
- `DBOS_EXECUTOR_ID` is required (no `"local"` default) and must differ per running process; `DbosExecutor` fails fast without it.
- `executeRun`'s `running` flip and both terminal writes are conditional on `status in [pending, running]` (first terminal write wins), and a run already terminal is returned untouched.
- Cancellation lands as `status: "cancelled"` via `RunCancelledError`; `start()` reconciles a rejected `getResult()` with the conditional `markRunFailedFromExecutorError` only.
- `recover()` uses `DBOS.executorID`, bounds adoption at 3 attempts, and declares `lost` on an application-version mismatch; `launch()` throws if DBOS is already launched under a different id.
- `startMcp()` returns a close handle that `cli.ts`'s shutdown closure awaits; no signal handlers in `mcp/index.ts`.
- The crash-resume acceptance test restarts under a different executor id so orphan adoption is exercised.
- Known follow-up: a losing concurrent attempt's `DBOSWorkflowConflictError` should become a `RunOwnershipLostError` that the runner backstop rethrows without persisting, so DBOS's duplicate-abort path handles it.

## Global Constraints

- Node.js `>=22.12.0` (`package.json` engines). DBOS SDK 4.27.6 requires `>=20`.
- Pin `@dbos-inc/dbos-sdk` to an exact version: `4.27.6`.
- CLEANROOM.md: implement from the DBOS public docs and the SDK's shipped
  `.d.ts` typings only. Never open another project's DBOS integration.
- CLAUDE.md Prisma rules are STRICT: the schema change in Task 3 ships with a
  hand-written migration, never `prisma db push`, never edit an applied
  migration, and the drift check must print `-- This is an empty migration.`
- DBOS's own system tables live in the `dbos` schema of the wardby database by
  default (override with `DBOS_SYSTEM_DATABASE_URL`). They are NOT part of
  `schema.prisma`. Prisma only manages `public`, so the drift check is
  unaffected. Never add them to `schema.prisma`.
- Every model call must still go through `ctx.providers.llm` (engine seam
  comment). DBOS must never auto-retry a step that spends money:
  `retriesAllowed: false` on every step.
- The in-process executor's behavior must not change. Existing tests in
  `src/core/engine-native.test.ts`, `src/core/runner.test.ts`,
  `src/core/reconciler.test.ts`, and `src/providers/executor/in-process.test.ts`
  must keep passing unmodified except where a task explicitly says otherwise.
- Test gating convention: unit tests run everywhere; anything needing Postgres
  uses `describe.skipIf(!process.env.DATABASE_URL)` and lives in a
  `*.database.test.ts` file (see `src/core/secrets.database.test.ts`).
- Run `npm run lint && npm run format:check && npm run typecheck` before each
  commit. Prettier is authoritative for formatting.

## Verified DBOS 4.27.6 API (from the shipped typings, `dist/src/dbos.d.ts`)

Use exactly these names. Do not guess others.

```ts
import { DBOS, DBOSWorkflowCancelledError } from "@dbos-inc/dbos-sdk";

DBOS.setConfig({ name, systemDatabaseUrl, systemDatabaseSchemaName, executorID, runAdminServer: false, logLevel });
await DBOS.launch();                       // runs DBOS's own migrations, then recovers this executorID's PENDING workflows
await DBOS.shutdown({ workflowCompletionTimeoutMS });
DBOS.isInitialized(): boolean;
DBOS.executorID: string;                   // static getter; defaults to process.env.DBOS__VMID || "local"

const wf = DBOS.registerWorkflow(async (runId: string) => {...}, { name: "wardby.run" }); // MUST be called before launch()
const handle = await DBOS.startWorkflow(wf, { workflowID: runId, duplicationPolicy: "return-existing" })(runId);
await DBOS.runStep(() => Promise<T>, { name, retriesAllowed: false });  // only valid inside a workflow
await DBOS.getWorkflowStatus(id);          // null | { status: "PENDING"|"SUCCESS"|"ERROR"|"MAX_RECOVERY_ATTEMPTS_EXCEEDED"|"CANCELLED"|"ENQUEUED"|"DELAYED", executorId?: string, ... }
await DBOS.cancelWorkflow(id);             // the workflow's next runStep throws DBOSWorkflowCancelledError
await DBOS.resumeWorkflow(id);             // re-drives a workflow from its last completed step on THIS executor
```

Workflow inputs and step outputs are serialized with superjson; every step
return value in this plan is plain JSON data.

## File Structure

| File                                                                                           | Responsibility                                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/config/providers.ts`                                                                      | Add `DbosConfig` + `loadDbosConfig()` (env → config).                               |
| `src/config/providers.test.ts`                                                                 | Config unit tests.                                                                  |
| `src/providers/engine/types.ts`                                                                | Add `StepRunner` type, `runStepInline`, and optional `step` on `EngineRunContext`.  |
| `src/core/engine-native.ts`                                                                    | Wrap estimate / LLM turn / tool call / wind-down in `step`.                         |
| `src/core/engine-native.test.ts`                                                               | Replay-safety test with a recording step runner.                                    |
| `src/core/runner.ts`                                                                           | `executeRun` accepts `step`; wraps agent+tools+budget load in a `load` step.        |
| `src/core/runner.test.ts`                                                                      | Load-step test.                                                                     |
| `prisma/schema.prisma`, `prisma/migrations/20260908010000_run_execution_backend/migration.sql` | Nullable `Run.executionBackend`.                                                    |
| `src/providers/executor/types.ts`                                                              | Optional `launch`/`close` lifecycle on `Executor`.                                  |
| `src/providers/executor/dbos-status.ts`                                                        | Pure mapping from DBOS workflow status → `ExecutionRecoveryResult` decision.        |
| `src/providers/executor/dbos-status.test.ts`                                                   | Unit tests for the mapping.                                                         |
| `src/providers/executor/dbos.ts`                                                               | `DbosExecutor`: launch/close, start, stop, recover.                                 |
| `src/providers/executor/dbos.database.test.ts`                                                 | Integration tests against local Postgres (start, idempotent start, cancel, resume). |
| `src/providers/executor/build.ts`                                                              | `buildExecutor(config, deps, db)` factory.                                          |
| `src/providers/executor/build.test.ts`                                                         | Factory unit tests.                                                                 |
| `src/providers/executor/index.ts`                                                              | Re-exports.                                                                         |
| `src/core/reconciler.ts`                                                                       | Generalize handle-based recovery to any run with `executionBackend`.                |
| `src/core/reconciler.test.ts`                                                                  | Reconciler tests for the new branch.                                                |
| `src/cli.ts`, `src/mcp/index.ts`                                                               | Use `buildExecutor`; call `launch`/`close`.                                         |
| `.env.example`, `README.md`, `docs/security-deployment.md`                                     | Config and operator docs.                                                           |

---

### Task 0: Dependency and configuration

**Files:**

- Modify: `package.json`
- Modify: `src/config/providers.ts`
- Modify: `src/config/providers.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Produces: `interface DbosConfig { systemDatabaseUrl: string | undefined; schemaName: string; executorId: string; }` and `loadDbosConfig(env?: NodeJS.ProcessEnv): DbosConfig` exported from `src/config/providers.ts`.

- [ ] **Step 1: Install the SDK pinned**

```bash
npm install --save-exact @dbos-inc/dbos-sdk@4.27.6
```

Verify `package.json` shows `"@dbos-inc/dbos-sdk": "4.27.6"` (no caret).

- [ ] **Step 2: Write the failing config test**

Append to `src/config/providers.test.ts` (keep its existing imports; add `loadDbosConfig` to the import from `./providers.js`):

```ts
describe("loadDbosConfig", () => {
  it("defaults the system database to DATABASE_URL, schema dbos, executor id local", () => {
    const config = loadDbosConfig({ DATABASE_URL: "postgresql://wardby:wardby@localhost:55432/wardby" });
    expect(config).toEqual({
      systemDatabaseUrl: "postgresql://wardby:wardby@localhost:55432/wardby",
      schemaName: "dbos",
      executorId: "local",
    });
  });

  it("honours explicit overrides", () => {
    const config = loadDbosConfig({
      DATABASE_URL: "postgresql://a",
      DBOS_SYSTEM_DATABASE_URL: "postgresql://b",
      DBOS_SCHEMA: "durable",
      DBOS_EXECUTOR_ID: "scheduler-1",
    });
    expect(config).toEqual({ systemDatabaseUrl: "postgresql://b", schemaName: "durable", executorId: "scheduler-1" });
  });

  it("leaves systemDatabaseUrl undefined when neither variable is set", () => {
    expect(loadDbosConfig({}).systemDatabaseUrl).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/config/providers.test.ts`
Expected: FAIL, `loadDbosConfig` is not exported.

- [ ] **Step 4: Implement `loadDbosConfig`**

Append to `src/config/providers.ts`:

```ts
export interface DbosConfig {
  /**
   * Where DBOS keeps its workflow/step tables. Defaults to DATABASE_URL —
   * the tables live in their own schema (`schemaName`), so Prisma's `public`
   * schema and the migration drift check are untouched.
   */
  systemDatabaseUrl: string | undefined;
  schemaName: string;
  /**
   * Stable per-deployment executor identity. At launch DBOS re-drives every
   * PENDING workflow that this id owned, so a restarted process picks up its
   * own interrupted runs. Give each long-lived instance its own value.
   */
  executorId: string;
}

/** Read DBOS executor config from the environment (only used when EXECUTOR=dbos). */
export function loadDbosConfig(env: NodeJS.ProcessEnv = process.env): DbosConfig {
  return {
    systemDatabaseUrl: env.DBOS_SYSTEM_DATABASE_URL ?? env.DATABASE_URL,
    schemaName: env.DBOS_SCHEMA ?? "dbos",
    executorId: env.DBOS_EXECUTOR_ID ?? "local",
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/config/providers.test.ts`
Expected: PASS.

- [ ] **Step 6: Document the variables**

Append to `.env.example`:

```bash

# EXECUTOR=in-process (default): heartbeat + reconciler durability; a run whose
# process dies is reconciled to `lost`. EXECUTOR=dbos: each run is a DBOS
# durable workflow that resumes from its last completed LLM turn / tool call
# after a crash or redeploy, and `stop` is a real cancellation.
EXECUTOR=in-process
# DBOS keeps its workflow tables in schema DBOS_SCHEMA of this database.
# Defaults to DATABASE_URL; point elsewhere to keep them in a separate DB.
DBOS_SYSTEM_DATABASE_URL=
DBOS_SCHEMA=dbos
# Stable per-instance id. A restarted instance with the same id re-drives its
# own interrupted runs at launch. Use a distinct value per long-lived process.
DBOS_EXECUTOR_ID=local
```

- [ ] **Step 7: Lint, format, commit**

```bash
npm run lint && npm run format:check && npm run typecheck
git add package.json package-lock.json src/config/providers.ts src/config/providers.test.ts .env.example
git commit -m "feat(executor): add DBOS SDK dependency and DBOS config loader"
```

---

### Task 1: Step boundary in the engine seam and native engine

**Files:**

- Modify: `src/providers/engine/types.ts`
- Modify: `src/core/engine-native.ts`
- Modify: `src/core/engine-native.test.ts`

**Interfaces:**

- Produces: `type StepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>`, `const runStepInline: StepRunner`, and `EngineRunContext.step?: StepRunner`, all exported from `src/providers/engine/types.ts`.
- Step names emitted by `NativeEngine.run`, in order, for turn N (1-based): `turn:N:estimate`, `turn:N:llm`, then `turn:N:tool:I` for each tool call I (0-based). Wind-down emits `winddown:estimate` then `winddown:llm`.

- [ ] **Step 1: Write the failing replay-safety test**

Add to `src/core/engine-native.test.ts`, inside `describe("NativeEngine", ...)`. Import `StepRunner` from `../providers/engine/types.js`.

```ts
/** Records each step's JSON result; on a later run replays it without calling fn. */
function recordingStepRunner(record: Map<string, unknown>, calls: string[]): StepRunner {
  return async (name, fn) => {
    calls.push(name);
    if (record.has(name)) return record.get(name) as never;
    const value = await fn();
    record.set(name, JSON.parse(JSON.stringify(value)));
    return value;
  };
}

it("routes every LLM turn, estimate, and tool call through ctx.step with deterministic names", async () => {
  const llm = scriptedLlm(
    [
      [
        { type: "tool_call", id: "c1", name: "getWeather", argsJson: '{"city":"Boston"}' },
        { type: "done", stopReason: "tool_calls", usage: { inputTokens: 9, outputTokens: 2, costUsd: 11 } },
      ],
      [
        { type: "text", delta: "72F" },
        { type: "done", stopReason: "stop", usage: { inputTokens: 20, outputTokens: 6, costUsd: 26 } },
      ],
    ],
    (usage) => usage.inputTokens + usage.outputTokens,
    (messages) => messages.reduce((sum, m) => sum + m.content.length, 0),
  );
  const calls: string[] = [];
  const ctx = makeContext({ llm, step: recordingStepRunner(new Map(), calls) });

  const result = await new NativeEngine().run(ctx);

  expect(result.status).toBe("succeeded");
  expect(calls).toEqual(["turn:1:estimate", "turn:1:llm", "turn:1:tool:0", "turn:2:estimate", "turn:2:llm"]);
});

it("replays a recorded run to the same result with zero LLM or tool calls (crash-resume safety)", async () => {
  const scripts: LlmStreamEvent[][] = [
    [
      { type: "tool_call", id: "c1", name: "getWeather", argsJson: '{"city":"Boston"}' },
      { type: "done", stopReason: "tool_calls", usage: { inputTokens: 9, outputTokens: 2, costUsd: 11 } },
    ],
    [
      { type: "text", delta: "72F" },
      { type: "done", stopReason: "stop", usage: { inputTokens: 20, outputTokens: 6, costUsd: 26 } },
    ],
  ];
  const price = (usage: { inputTokens: number; outputTokens: number }) => usage.inputTokens + usage.outputTokens;
  const count = (messages: { content: string }[]) => messages.reduce((sum, m) => sum + m.content.length, 0);
  const record = new Map<string, unknown>();

  const firstLlm = scriptedLlm(scripts, price, count);
  const firstTool = vi.fn(async () => '{"tempF":72}');
  const first = await new NativeEngine().run(
    makeContext({ llm: firstLlm, runSandboxTool: firstTool, step: recordingStepRunner(record, []) }),
  );

  const replayLlm = scriptedLlm(scripts, price, count);
  const replayTool = vi.fn(async () => '{"tempF":72}');
  const replayed = await new NativeEngine().run(
    makeContext({ llm: replayLlm, runSandboxTool: replayTool, step: recordingStepRunner(record, []) }),
  );

  expect(replayed).toEqual(first);
  expect(replayLlm.calls).toHaveLength(0);
  expect(replayTool).not.toHaveBeenCalled();
});

it("names wind-down steps distinctly so a replay after budget exhaustion lines up", async () => {
  const llm = scriptedLlm(
    [
      [
        { type: "tool_call", id: "c1", name: "t", argsJson: "{}" },
        { type: "done", stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 } },
      ],
      [
        { type: "text", delta: "summary" },
        { type: "done", stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 } },
      ],
    ],
    () => 0.1,
    () => 1000, // turn 2's estimate blows the remaining budget → wind-down
  );
  const calls: string[] = [];
  const ctx = makeContext({
    llm,
    agent: { systemPrompt: "sys", model: "m", budgetUsd: 0.6, maxTurns: 10 },
    step: recordingStepRunner(new Map(), calls),
  });

  const result = await new NativeEngine().run(ctx);

  expect(result.status).toBe("budget_exhausted");
  expect(calls.slice(0, 3)).toEqual(["turn:1:estimate", "turn:1:llm", "turn:1:tool:0"]);
  expect(calls).toContain("winddown:estimate");
});
```

Note for the third test: check the existing wind-down tests in this file for the
exact pricing/countTokens combination that reliably triggers wind-down (not
turn-1 refusal) and copy those numbers if the ones above don't. The assertion
that matters is the presence of `winddown:estimate` after the turn-1 steps.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/engine-native.test.ts`
Expected: FAIL with type error on `step` (not in `EngineRunContext`) or `calls` empty.

- [ ] **Step 3: Add the seam type**

In `src/providers/engine/types.ts`, add after `LoadedTool`:

```ts
/**
 * Durable step boundary. A checkpointing executor (DbosExecutor) supplies
 * one that records each step's result, so a run resumed after a crash
 * replays completed steps from the record instead of re-executing them
 * (and re-spending). When absent, `fn` runs directly.
 *
 * Contract for engines: `fn`'s return value must be plain JSON data, and
 * `name` must be deterministic for a given position in the run — the
 * replay matches steps by order, so control flow between steps must depend
 * only on earlier step results and on `agent` fields fixed at run start.
 */
export type StepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** The no-checkpoint default: run the step body directly. */
export const runStepInline: StepRunner = (_name, fn) => fn();
```

and add to `EngineRunContext`:

```ts
  /** See StepRunner. Optional; the in-process executor leaves it unset. */
  step?: StepRunner;
```

- [ ] **Step 4: Wrap the native engine's side effects**

In `src/core/engine-native.ts`:

Import `runStepInline` from `../providers/engine/types.js`.

At the top of `run(ctx)`, after `toolDefs`:

```ts
const step = ctx.step ?? runStepInline;
```

Replace the estimate call in the loop:

```ts
const { costUsd: inputEstimateCost, tokens: inputTokens } = await step(`turn:${turns}:estimate`, () =>
  estimateInputCost(
    { model: ctx.agent.model, budgetUsd: ctx.agent.budgetUsd },
    messages,
    ctx.providers.llm,
    toolDefs,
    lastCacheRatio,
  ),
);
```

Replace the turn call:

```ts
const turn = await step(`turn:${turns}:llm`, () =>
  this.runOneTurn(ctx, messages, inputTokens, cumulative.costUsd, toolDefs, lastCacheRatio),
);
```

Replace the tool loop body:

```ts
        for (const [index, toolCall] of turn.toolCalls.entries()) {
          const resultJson = await step(`turn:${turns}:tool:${index}`, () =>
            ctx.runSandboxTool(toolCall.name, toolCall.argsJson),
          );
```

In `windDown(...)`, obtain `const step = ctx.step ?? runStepInline;` and wrap
its `estimateInputCost(...)` call in `step("winddown:estimate", () => ...)` and
its `runOneTurn(...)` call in `step("winddown:llm", () => ...)`.

`TurnResult` and the estimate result are already plain data; no other change.

- [ ] **Step 5: Run the engine tests**

Run: `npx vitest run src/core/engine-native.test.ts`
Expected: PASS, including every pre-existing test (they don't set `step`, so `runStepInline` applies).

- [ ] **Step 6: Lint, format, commit**

```bash
npm run lint && npm run format:check && npm run typecheck
git add src/providers/engine/types.ts src/core/engine-native.ts src/core/engine-native.test.ts
git commit -m "feat(engine): add StepRunner seam; native engine checkpoints estimates, turns, and tool calls"
```

---

### Task 2: `executeRun` takes a step runner and checkpoints its load phase

**Files:**

- Modify: `src/core/runner.ts:47-75`
- Modify: `src/core/runner.test.ts`

**Interfaces:**

- Consumes: `StepRunner`, `runStepInline` from Task 1.
- Produces: `executeRun(runId, providers, db?, onText?, step?: StepRunner): Promise<Run>`. The load step is named `load` and returns `{ kind, agent: { systemPrompt, model, budgetUsd, maxTurns }, tools: LoadedTool[], toolsByName: Record<string, {...}> }` (see code).

Why: on replay, the agent row or its budget group may have changed. The engine's
control flow depends on `budgetUsd` and `maxTurns`, so they must be pinned to
the values seen on first execution or the replay's step order diverges from the
record.

- [ ] **Step 1: Write the failing test**

Add to `src/core/runner.test.ts` in `describe("runAgent", ...)`. This file has
`fakeDb`, `fakeEngine`-style helpers; reuse them exactly as the neighbouring
test "passes the agent's own budgetUsd unchanged to the engine" does. Import
`executeRun` alongside `runAgent`, and `StepRunner` from
`../providers/engine/types.js`.

```ts
it("pins agent fields, tools, and effective budget in a 'load' step so a replay sees first-run values", async () => {
  const agent = { id: "a1", name: "pinned", systemPrompt: "sys", model: "m", budgetUsd: 5, maxTurns: 3 };
  const db = fakeDb([agent], {}, [], []);
  const run = await db.run.create({ data: { agentId: "a1" } });

  const record = new Map<string, unknown>();
  const names: string[] = [];
  const step: StepRunner = async (name, fn) => {
    names.push(name);
    if (record.has(name)) return record.get(name) as never;
    const value = await fn();
    record.set(name, JSON.parse(JSON.stringify(value)));
    return value;
  };

  const seenBudgets: number[] = [];
  const engine = {
    async run(ctx: EngineRunContext) {
      seenBudgets.push(ctx.agent.budgetUsd);
      return {
        status: "succeeded",
        finalText: "",
        turns: 1,
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      } as EngineResult;
    },
  };
  const providers = { llm: fakeLlm(), engine, datastore: fakeDatastore(), secrets: fakeCipher() };

  await executeRun(run.id, providers, db, undefined, step);
  // Simulate the agent being edited between crash and resume.
  agent.budgetUsd = 999;
  await executeRun(run.id, providers, db, undefined, step);

  expect(names[0]).toBe("load");
  expect(seenBudgets).toEqual([5, 5]);
});
```

Adjust the `fakeDb(...)` call signature and helper names (`fakeLlm`,
`fakeCipher`, `fakeDatastore`) to whatever this file already defines — read the
file's helpers first; the two neighbouring budget tests show the exact
construction. If `run.create` in the fake throws "not used", create the run
record directly in the fake's run map the way those tests do.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/runner.test.ts`
Expected: FAIL, `seenBudgets` is `[5, 999]` (or `step` param rejected by TypeScript).

- [ ] **Step 3: Implement the load step**

In `src/core/runner.ts`, import `runStepInline, type StepRunner` from
`../providers/engine/types.js`. Change the signature:

```ts
export async function executeRun(
  runId: string,
  providers: Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets">,
  db: RunnerDb = defaultDb,
  onText?: (delta: string) => void,
  step: StepRunner = runStepInline,
): Promise<Run> {
```

Keep the `existingRun` lookup and the missing-run/missing-agent throws as they
are (they read only ids). Replace everything from the `agent.kind === "coding"`
check through the `toolsByName` construction and the `effectiveBudgetForRun`
call with one step:

```ts
const loaded = await step("load", async () => {
  const agent = await db.agent.findUnique({ where: { id: existingRun.agentId } });
  if (!agent) throw new Error(`Run "${runId}" references missing agent "${existingRun.agentId}".`);
  const attached = await db.agentTool.findMany({ where: { agentId: agent.id }, include: { tool: true } });
  const { effectiveBudgetUsd } = await effectiveBudgetForRun(db, agent);
  return {
    agentId: agent.id,
    kind: agent.kind,
    agent: {
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      budgetUsd: effectiveBudgetUsd,
      maxTurns: agent.maxTurns,
    },
    // jsonSchema was derived and validated once at tool-create time and
    // cached on the row; re-deriving per run would spin a QuickJS runtime
    // per tool before the first LLM call.
    tools: attached.map((attachment) => ({
      name: attachment.tool.name,
      description: attachment.tool.description,
      jsonSchema: attachment.tool.jsonSchema as Record<string, unknown>,
    })) as LoadedTool[],
    toolsByName: Object.fromEntries(
      attached.map((attachment) => [
        attachment.tool.name,
        {
          code: attachment.tool.code,
          paramsZod: attachment.tool.paramsZod,
          allowedSecrets: asStringArray(attachment.allowedSecrets),
          allowedDatastorePrefixes: asStringArray(attachment.allowedDatastorePrefixes),
          allowedHosts: asStringArray(attachment.allowedHosts),
        },
      ]),
    ),
  };
});

if (loaded.kind === "coding") {
  return db.run.update({
    where: { id: runId },
    data: {
      status: "failed",
      error: "Coding agent execution requires the Phase 5 container executor.",
      finishedAt: new Date(),
    },
  });
}

await db.run.update({ where: { id: runId }, data: { status: "running" } });
```

Then inside the existing `try`: `const toolsByName = new Map(Object.entries(loaded.toolsByName));`,
`const secretsAccessor = buildSecretsAccessor(loaded.agentId, providers.secrets, db);`,
replace `agent.id` with `loaded.agentId` in `runInSandbox`, and call the engine with:

```ts
const engineResult = await providers.engine.run({
  agent: loaded.agent,
  tools: loaded.tools,
  providers: { llm: providers.llm },
  runSandboxTool,
  onText,
  step,
});
```

Delete the now-unused `agent` variable and the old `tools`/`toolsByName`/`effectiveBudgetUsd` code. Keep the surrounding `try/catch` backstop unchanged.

- [ ] **Step 4: Run the runner and executor tests**

Run: `npx vitest run src/core/runner.test.ts src/providers/executor/in-process.test.ts src/core/engine-native.test.ts`
Expected: PASS. If a pre-existing runner test asserts the order of `db.agent.findUnique` / `agentTool.findMany` calls, it still holds — the order is unchanged, only wrapped.

- [ ] **Step 5: Lint, format, commit**

```bash
npm run lint && npm run format:check && npm run typecheck
git add src/core/runner.ts src/core/runner.test.ts
git commit -m "feat(runner): executeRun accepts a StepRunner and pins agent, tools, and budget in a load step"
```

---

### Task 3: `Run.executionBackend` column

**Files:**

- Modify: `prisma/schema.prisma` (model `Run`)
- Create: `prisma/migrations/20260908010000_run_execution_backend/migration.sql`

**Interfaces:**

- Produces: `Run.executionBackend: string | null`. `"dbos"` means a DBOS workflow with `workflowID === run.id` owns this run. Native in-process runs leave it null.

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, model `Run`, after `executionManaged`:

```prisma
  /// Phase 6: which durable executor backend holds this run, if any
  /// ("dbos" = a DBOS workflow whose id equals this run's id). Null for
  /// in-process runs. The reconciler consults the backend before declaring a
  /// stale run lost, and can adopt one orphaned by a dead instance.
  executionBackend String?
```

- [ ] **Step 2: Hand-write the migration**

Create `prisma/migrations/20260908010000_run_execution_backend/migration.sql`:

```sql
-- Phase 6: durable executor backend marker on Run (additive, nullable).
ALTER TABLE "Run" ADD COLUMN "executionBackend" TEXT;
```

- [ ] **Step 3: Apply locally, regenerate, and run the drift check**

```bash
npm run db:up
npx prisma migrate deploy
npm run prisma:generate
docker exec local-postgres-1 psql -U wardby -d wardby \
  -c "DROP DATABASE IF EXISTS wardby_shadow;" -c "CREATE DATABASE wardby_shadow;"
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://wardby:wardby@localhost:55432/wardby_shadow" \
  --script
docker exec local-postgres-1 psql -U wardby -d wardby -c "DROP DATABASE IF EXISTS wardby_shadow;"
npx prisma validate
```

Expected: the diff prints exactly `-- This is an empty migration.` and validate succeeds. Anything else means schema and SQL disagree — fix before continuing.

- [ ] **Step 4: Typecheck and full test run**

Run: `npm run typecheck && npm test`
Expected: PASS (the column is nullable with no default logic anywhere yet).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260908010000_run_execution_backend/migration.sql
git commit -m "feat(schema): add nullable Run.executionBackend for durable executor recovery"
```

---

### Task 4: DBOS status mapping (pure) and executor lifecycle on the seam

**Files:**

- Modify: `src/providers/executor/types.ts`
- Create: `src/providers/executor/dbos-status.ts`
- Create: `src/providers/executor/dbos-status.test.ts`

**Interfaces:**

- Produces on `Executor`: `launch?: () => Promise<void>` and `close?: () => Promise<void>`.
- Produces: `type RecoveryDecision = { action: "active" } | { action: "resume" } | { action: "terminal" } | { action: "mark-failed"; error: string } | { action: "lost"; reason: string }` and `decideRecovery(status: { status: string; executorId?: string } | null, runIsTerminal: boolean, selfExecutorId: string): RecoveryDecision` from `dbos-status.ts`.

- [ ] **Step 1: Add lifecycle to the seam**

In `src/providers/executor/types.ts`, add to `interface Executor`:

```ts
  /**
   * Optional one-time startup. A durable backend connects and re-drives the
   * workflows it owned before the last restart. Composition roots call it
   * before starting the scheduler or MCP server.
   */
  launch?: () => Promise<void>;
  /** Optional graceful shutdown counterpart to `launch`. */
  close?: () => Promise<void>;
```

- [ ] **Step 2: Write the failing mapping tests**

Create `src/providers/executor/dbos-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideRecovery } from "./dbos-status.js";

describe("decideRecovery", () => {
  it("treats a PENDING workflow owned by this executor as active", () => {
    expect(decideRecovery({ status: "PENDING", executorId: "me" }, false, "me")).toEqual({ action: "active" });
  });

  it("adopts a PENDING workflow owned by another executor by resuming it here", () => {
    expect(decideRecovery({ status: "PENDING", executorId: "dead-node" }, false, "me")).toEqual({ action: "resume" });
  });

  it("adopts an ENQUEUED or DELAYED workflow the same way", () => {
    expect(decideRecovery({ status: "ENQUEUED" }, false, "me")).toEqual({ action: "resume" });
    expect(decideRecovery({ status: "DELAYED" }, false, "me")).toEqual({ action: "resume" });
  });

  it("reports terminal when the workflow succeeded and the run row is already terminal", () => {
    expect(decideRecovery({ status: "SUCCESS" }, true, "me")).toEqual({ action: "terminal" });
  });

  it("marks the run failed when the workflow ended but the run row never reached a terminal state", () => {
    expect(decideRecovery({ status: "SUCCESS" }, false, "me")).toEqual({
      action: "mark-failed",
      error: "Durable workflow finished (SUCCESS) without persisting a terminal run state.",
    });
    expect(decideRecovery({ status: "ERROR" }, false, "me")).toEqual({
      action: "mark-failed",
      error: "Durable workflow finished (ERROR) without persisting a terminal run state.",
    });
    expect(decideRecovery({ status: "CANCELLED" }, false, "me")).toEqual({
      action: "mark-failed",
      error: "Durable workflow finished (CANCELLED) without persisting a terminal run state.",
    });
    expect(decideRecovery({ status: "MAX_RECOVERY_ATTEMPTS_EXCEEDED" }, false, "me")).toEqual({
      action: "mark-failed",
      error: "Durable workflow finished (MAX_RECOVERY_ATTEMPTS_EXCEEDED) without persisting a terminal run state.",
    });
  });

  it("reports lost when DBOS has no record of the workflow", () => {
    expect(decideRecovery(null, false, "me")).toEqual({
      action: "lost",
      reason: "Durable workflow record not found; the run was never started or its record was purged.",
    });
  });

  it("reports lost for an unknown status string rather than guessing", () => {
    expect(decideRecovery({ status: "SOMETHING_NEW" }, false, "me")).toEqual({
      action: "lost",
      reason: 'Durable workflow is in unrecognised status "SOMETHING_NEW".',
    });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/providers/executor/dbos-status.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the mapping**

Create `src/providers/executor/dbos-status.ts`:

```ts
/**
 * Pure decision table for reconciling a stale `Run` that a DBOS workflow
 * owns. Kept free of DBOS imports so it is unit-testable without Postgres.
 */

export interface WorkflowStatusLike {
  status: string;
  executorId?: string;
}

export type RecoveryDecision =
  | { action: "active" }
  | { action: "resume" }
  | { action: "terminal" }
  | { action: "mark-failed"; error: string }
  | { action: "lost"; reason: string };

const LIVE = new Set(["PENDING", "ENQUEUED", "DELAYED"]);
const FINISHED = new Set(["SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"]);

export function decideRecovery(
  status: WorkflowStatusLike | null,
  runIsTerminal: boolean,
  selfExecutorId: string,
): RecoveryDecision {
  if (!status) {
    return {
      action: "lost",
      reason: "Durable workflow record not found; the run was never started or its record was purged.",
    };
  }
  if (LIVE.has(status.status)) {
    // A live workflow this process owns is simply still running (its
    // heartbeat lapsed under load). One owned by another executor id whose
    // heartbeat lapsed is orphaned — that executor died — so adopt it.
    return status.status === "PENDING" && status.executorId === selfExecutorId
      ? { action: "active" }
      : { action: "resume" };
  }
  if (FINISHED.has(status.status)) {
    return runIsTerminal
      ? { action: "terminal" }
      : {
          action: "mark-failed",
          error: `Durable workflow finished (${status.status}) without persisting a terminal run state.`,
        };
  }
  return { action: "lost", reason: `Durable workflow is in unrecognised status "${status.status}".` };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/providers/executor/dbos-status.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run format:check
git add src/providers/executor/types.ts src/providers/executor/dbos-status.ts src/providers/executor/dbos-status.test.ts
git commit -m "feat(executor): optional launch/close lifecycle; pure DBOS recovery decision table"
```

---

### Task 5: `DbosExecutor` — launch, start, stop

**Files:**

- Create: `src/providers/executor/dbos.ts`
- Create: `src/providers/executor/dbos.database.test.ts`
- Modify: `src/providers/executor/index.ts`

**Interfaces:**

- Consumes: `executeRun(runId, providers, db, onText, step)` (Task 2), `DbosConfig` (Task 0), `Executor` with `launch`/`close` (Task 4), `Run.executionBackend` (Task 3).
- Produces: `class DbosExecutor implements Executor` with `constructor(providers: Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets">, config: DbosConfig, db: RunnerDb & Pick<PrismaClient, "run"> = prisma, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS)`, `launch()`, `close()`, `start(runId)`, `stop(runId, reason?)`. `recover` is added in Task 6. Exported constant `DBOS_BACKEND = "dbos"`.

Design notes the implementer must respect:

- DBOS is a process-global singleton. The workflow is registered once at
  module load (registration must precede `DBOS.launch()`); the workflow body
  reaches the executor instance through a module-level `activeExecutor`
  variable set in `launch()`. A second `DbosExecutor` launched in the same
  process replaces it (tests create one per file).
- `start` is fire-and-forget from the caller's perspective, exactly like the
  in-process executor: it returns once the workflow is durably enqueued and
  awaits the result so `dispatchRun`'s `.catch(markRunFailedFromExecutorError)`
  still sees a throw if the workflow throws.
- `workflowID = runId` with `duplicationPolicy: "return-existing"` makes a
  duplicate `start(runId)` (scheduler retry, double dispatch) attach to the
  existing workflow rather than run it twice.
- Heartbeat continues while the workflow runs in this process so the existing
  reconciler timeout semantics hold unchanged during normal operation.
- Every `runStep` is `retriesAllowed: false`: the engine already handles
  provider errors and a retry would double-spend.

- [ ] **Step 1: Write the failing integration tests**

Create `src/providers/executor/dbos.database.test.ts`. These need Postgres
(`DATABASE_URL`) and are skipped otherwise. They use a scripted LLM so no network.

```ts
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "../llm/types.js";
import type { Datastore, DatastoreValue } from "../datastore/types.js";
import type { SecretCipher } from "../secrets/types.js";
import { NativeEngine } from "../../core/engine-native.js";
import { DBOS_BACKEND, DbosExecutor } from "./dbos.js";

/** One scripted event list per stream() call; `gate` lets a test hold a turn open. */
function scriptedLlm(scripts: LlmStreamEvent[][], gate?: { turn: number; open: Promise<void> }) {
  let index = 0;
  const calls: LlmRequest[] = [];
  const llm: LlmProvider & { calls: LlmRequest[] } = {
    calls,
    async *stream(req) {
      const turn = ++index;
      calls.push(req);
      if (gate && gate.turn === turn) await gate.open;
      for (const event of scripts[turn - 1] ?? []) yield event;
    },
    async countTokens() {
      return 10;
    },
    priceUsd(_model, usage) {
      return (usage.inputTokens + usage.outputTokens) / 1000;
    },
  };
  return llm;
}

const finalAnswer = (text: string): LlmStreamEvent[] => [
  { type: "text", delta: text },
  { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.015 } },
];
const toolCall = (name: string): LlmStreamEvent[] => [
  { type: "tool_call", id: "c1", name, argsJson: "{}" },
  { type: "done", stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.012 } },
];

function fakeDatastore(): Datastore {
  const store = new Map<string, DatastoreValue>();
  return {
    async get(agentId, key) {
      return store.get(`${agentId}:${key}`);
    },
    async set(agentId, key, value) {
      store.set(`${agentId}:${key}`, value);
    },
    async delete(agentId, key) {
      store.delete(`${agentId}:${key}`);
    },
    async list() {
      return [];
    },
  };
}
const fakeCipher: SecretCipher = { keyId: () => "t", encrypt: async (s) => s, decrypt: async (s) => s };

describe.skipIf(!process.env.DATABASE_URL)("DbosExecutor (database)", () => {
  const db = new PrismaClient();
  const suffix = randomUUID();
  const agentId = `dbos-agent-${suffix}`;
  const executorId = `test-${suffix}`;
  let executor: DbosExecutor | undefined;

  beforeAll(async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "sys", model: "m", budgetUsd: 1, maxTurns: 5 },
    });
  });

  afterAll(async () => {
    await executor?.close();
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  function build(llm: LlmProvider) {
    return new DbosExecutor(
      { llm, engine: new NativeEngine(), datastore: fakeDatastore(), secrets: fakeCipher },
      { systemDatabaseUrl: process.env.DATABASE_URL, schemaName: "dbos_test", executorId },
      db,
      /* heartbeatIntervalMs */ 50,
    );
  }

  it("runs a native run to a terminal state under DBOS and marks the backend on the row", async () => {
    const llm = scriptedLlm([toolCall("nope"), finalAnswer("done")]);
    executor = build(llm);
    await executor.launch();
    const run = await db.run.create({ data: { agentId, executionManaged: true } });

    await executor.start(run.id);

    const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("succeeded");
    expect(after.finalText).toBe("done");
    expect(after.executionBackend).toBe(DBOS_BACKEND);
    expect(after.turns).toBe(2);
    expect(llm.calls).toHaveLength(2);
  });

  it("is idempotent: a second start for the same run attaches to the existing workflow", async () => {
    const llm = scriptedLlm([finalAnswer("once")]);
    executor = build(llm);
    await executor.launch();
    const run = await db.run.create({ data: { agentId, executionManaged: true } });

    await Promise.all([executor.start(run.id), executor.start(run.id)]);

    const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("succeeded");
    expect(llm.calls).toHaveLength(1);
  });

  it("stop cancels a running workflow and the run lands failed rather than hanging", async () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const llm = scriptedLlm([toolCall("t"), finalAnswer("never")], { turn: 2, open });
    executor = build(llm);
    await executor.launch();
    const run = await db.run.create({ data: { agentId, executionManaged: true } });

    const started = executor.start(run.id);
    // Wait until turn 2 is blocked inside the LLM step.
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (llm.calls.length === 2) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    await executor.stop(run.id, "operator cancelled");
    release();
    await started.catch(() => undefined);

    const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("failed");
    expect(after.finishedAt).not.toBeNull();
  });
});
```

Cancellation semantics to verify while implementing: `DBOS.cancelWorkflow`
marks the workflow CANCELLED and the _next_ `runStep` inside it throws
`DBOSWorkflowCancelledError`. That error propagates out of the engine into
`executeRun`'s catch backstop, which persists `failed` with the error message.
If the current step is the last one (no further `runStep` follows), the
workflow completes normally instead — the test above blocks turn 2, whose tool
step and turn 3 follow, so cancellation is observed.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/executor/dbos.database.test.ts`
Expected: FAIL, `./dbos.js` not found (with `DATABASE_URL` set; without it, the suite skips — set it from `.env.local` per the repo convention).

- [ ] **Step 3: Implement `DbosExecutor`**

Create `src/providers/executor/dbos.ts`:

```ts
/**
 * Phase 6 `Executor`: each native run is a DBOS durable workflow whose
 * steps are the engine's LLM turns and tool calls (see StepRunner in
 * providers/engine/types.ts). DBOS records every step result in Postgres;
 * after a crash or redeploy `launch()` re-drives the workflows this
 * executor id owned, and completed steps replay from the record — no
 * repeated LLM spend for finished turns. The at-least-once window is one
 * in-flight step: a turn that was mid-stream when the process died runs
 * again on resume.
 *
 * The heartbeat is kept while the workflow runs here so the reconciler's
 * stale-heartbeat detection is unchanged; the reconciler consults
 * `recover()` (Task 6) before declaring a DBOS run lost.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { PrismaClient } from "@prisma/client";
import type { ProviderRegistry } from "../index.js";
import type { DbosConfig } from "../../config/providers.js";
import type { StepRunner } from "../engine/types.js";
import { executeRun, type RunnerDb } from "../../core/runner.js";
import { prisma as defaultDb } from "../../core/db.js";
import { HEARTBEAT_INTERVAL_MS } from "../../core/timing.js";
import { logger } from "../../core/logger.js";
import type { Executor } from "./types.js";

export const DBOS_BACKEND = "dbos";

const dbosLog = logger.child({ module: "dbos-executor" });

type Providers = Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets">;
type Db = RunnerDb & Pick<PrismaClient, "run">;

/** The executor whose deps the registered workflow uses. Set by launch(). */
let activeExecutor: DbosExecutor | undefined;

/** Bind the engine's step boundary to a DBOS checkpointed step. Never retried: a retry would re-spend. */
const dbosStep: StepRunner = (name, fn) => DBOS.runStep(fn, { name, retriesAllowed: false });

/**
 * Registered once at module load — DBOS requires registration before
 * launch(). The body must be deterministic between steps; everything
 * non-deterministic in executeRun/engine is inside a runStep.
 */
const runWorkflow = DBOS.registerWorkflow(
  async (runId: string): Promise<void> => {
    const self = activeExecutor;
    if (!self) throw new Error("DbosExecutor workflow invoked before launch().");
    await self.runInsideWorkflow(runId);
  },
  { name: "wardby.run" },
);

export class DbosExecutor implements Executor {
  private launched = false;

  constructor(
    private readonly providers: Providers,
    private readonly config: DbosConfig,
    private readonly db: Db = defaultDb,
    private readonly heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {
    if (!config.systemDatabaseUrl) {
      throw new Error("EXECUTOR=dbos requires DBOS_SYSTEM_DATABASE_URL or DATABASE_URL.");
    }
  }

  get executorId(): string {
    return this.config.executorId;
  }

  async launch(): Promise<void> {
    if (this.launched) return;
    activeExecutor = this;
    if (!DBOS.isInitialized()) {
      DBOS.setConfig({
        name: "wardby",
        systemDatabaseUrl: this.config.systemDatabaseUrl,
        systemDatabaseSchemaName: this.config.schemaName,
        executorID: this.config.executorId,
        runAdminServer: false,
        logLevel: "warn",
      });
      await DBOS.launch();
    }
    this.launched = true;
    dbosLog.info({ executorId: DBOS.executorID }, "DBOS executor launched");
  }

  async close(): Promise<void> {
    if (!this.launched) return;
    this.launched = false;
    if (activeExecutor === this) activeExecutor = undefined;
    await DBOS.shutdown({ workflowCompletionTimeoutMS: 5_000 });
  }

  async start(runId: string): Promise<void> {
    if (!this.launched) await this.launch();
    await this.db.run.updateMany({
      where: { id: runId, executionBackend: null },
      data: { executionBackend: DBOS_BACKEND },
    });
    const handle = await DBOS.startWorkflow(runWorkflow, {
      workflowID: runId,
      duplicationPolicy: "return-existing",
    })(runId);
    await handle.getResult();
  }

  async stop(runId: string, reason?: string): Promise<void> {
    dbosLog.info({ runId, reason }, "cancelling durable run");
    await DBOS.cancelWorkflow(runId);
  }

  /** Workflow body. Public only so the module-level registration can reach it. */
  async runInsideWorkflow(runId: string): Promise<void> {
    const beat = () =>
      this.db.run.update({ where: { id: runId }, data: { heartbeatAt: new Date() } }).catch(() => {
        // A missed beat only makes the reconciler look sooner; recover() answers it.
      });
    await beat();
    const timer = setInterval(() => void beat(), this.heartbeatIntervalMs);
    try {
      await executeRun(runId, this.providers, this.db, undefined, dbosStep);
    } finally {
      clearInterval(timer);
    }
  }
}
```

Add to `src/providers/executor/index.ts`:

```ts
export * from "./dbos.js";
export * from "./dbos-status.js";
```

Implementation checks while making the tests pass:

1. If `DBOS.setConfig` rejects `executorID` or `DBOS.executorID` does not equal
   the configured id after launch, also set `process.env.DBOS__VMID =
config.executorId` before `DBOS.launch()` (the SDK reads that variable as
   its executor id) and add `expect(executor.executorId).toBe(DBOS.executorID)`
   to the first test.
2. If `handle.getResult()` rejects for a cancelled workflow, that is fine —
   `start` rejects, `dispatchRun` already routes a rejection into
   `markRunFailedFromExecutorError`, which is a conditional update and will not
   clobber the `failed` state executeRun's backstop already wrote.
3. The in-process heartbeat write uses `db.run.update`; keep that here for
   symmetry with `InProcessExecutor`.

- [ ] **Step 4: Run the integration tests**

Run: `npx vitest run src/providers/executor/dbos.database.test.ts`
Expected: PASS (3 tests). Then `npm test` to confirm nothing else regressed.

- [ ] **Step 5: Lint, format, commit**

```bash
npm run lint && npm run format:check && npm run typecheck
git add src/providers/executor/dbos.ts src/providers/executor/dbos.database.test.ts src/providers/executor/index.ts
git commit -m "feat(executor): DbosExecutor runs native runs as DBOS durable workflows with real cancellation"
```

---

### Task 6: Recovery — `DbosExecutor.recover` and reconciler generalization

**Files:**

- Modify: `src/providers/executor/dbos.ts`
- Modify: `src/core/reconciler.ts:41-102`
- Modify: `src/core/reconciler.test.ts`
- Modify: `src/providers/executor/dbos.database.test.ts`

**Interfaces:**

- Consumes: `decideRecovery` (Task 4), `Run.executionBackend` (Task 3).
- Produces: `DbosExecutor.recover(handle: PersistedExecutionHandle): Promise<ExecutionRecoveryResult>` where `handle.backend === "dbos"` and `handle.id === runId`.
- Reconciler: a stale run with `executionBackend` set (and no coding handle) is routed to `executor.recover({ runId, backend: run.executionBackend, id: run.id })` behind a compare-and-set heartbeat claim so only one reconciler instance adopts it.

- [ ] **Step 1: Write the failing reconciler tests**

In `src/core/reconciler.test.ts`, extend `FakeRun` with `executionBackend: string | null` and give every existing fixture `executionBackend: null` (search for `codingRun:` in fixture builders and add the field beside it; if there is a `makeRun` helper, default it there). The fake db's `findMany` must also return `executionBackend`. Then add:

```ts
it("consults the executor before reaping a stale run held by a durable backend, and keeps it alive when active", async () => {
  const run = makeRun({ status: "running", heartbeatAt: old, executionBackend: "dbos" });
  const db = fakeDb([run]);
  const recover = vi.fn(async () => ({ state: "active" as const }));
  const executor: Executor = { start: async () => undefined, stop: async () => undefined, recover };

  const lost = await reconcileOnce(db, now, TIMEOUT, executor);

  expect(lost).toBe(0);
  expect(recover).toHaveBeenCalledWith({ runId: run.id, backend: "dbos", id: run.id });
  expect(run.status).toBe("running");
  expect(run.heartbeatAt).toEqual(now);
});

it("marks a durable-backend run lost when the executor reports it lost", async () => {
  const run = makeRun({ status: "running", heartbeatAt: old, executionBackend: "dbos" });
  const db = fakeDb([run]);
  const executor: Executor = {
    start: async () => undefined,
    stop: async () => undefined,
    recover: async () => ({ state: "lost", reason: "gone" }),
  };

  const lost = await reconcileOnce(db, now, TIMEOUT, executor);

  expect(lost).toBe(1);
  expect(run.status).toBe("lost");
  expect(run.error).toBe("gone");
});

it("leaves a durable-backend run alone when the executor reports terminal", async () => {
  const run = makeRun({ status: "running", heartbeatAt: old, executionBackend: "dbos" });
  const db = fakeDb([run]);
  const executor: Executor = {
    start: async () => undefined,
    stop: async () => undefined,
    recover: async () => ({ state: "terminal" }),
  };

  expect(await reconcileOnce(db, now, TIMEOUT, executor)).toBe(0);
  expect(run.status).toBe("running"); // the executor's recover() owns the terminal write
});

it("falls back to the plain lost path for a durable-backend run when no executor can recover", async () => {
  const run = makeRun({ status: "running", heartbeatAt: old, executionBackend: "dbos" });
  const db = fakeDb([run]);

  expect(await reconcileOnce(db, now, TIMEOUT, undefined)).toBe(1);
  expect(run.status).toBe("lost");
});
```

Use this file's existing fixture helper names and its `now`/`old`/timeout
constants — read the first existing test ("marks a scheduled run with a stale
heartbeat as lost") and mirror its construction exactly. The fake db's
`updateMany` must apply `where` via `matches` and return `{ count }` as it
already does for the coding path; the "keeps it alive" test relies on the
heartbeat claim's `updateMany` matching the stale run.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/reconciler.test.ts`
Expected: the four new tests FAIL (durable run reaped as plain lost; `recover` never called).

- [ ] **Step 3: Generalize the reconciler**

In `src/core/reconciler.ts`, inside the `for (const run of candidates)` loop,
add a branch between the coding-handle branch and the `else if (run.agent.kind === "coding")` fallback:

```ts
    } else if (run.executionBackend && executor?.recover) {
      // Claim before asking, so two reconciler instances can't both adopt
      // the same orphaned workflow: whichever CAS wins refreshes the
      // heartbeat and takes the run out of the stale set for the other.
      const claimed = await db.run.updateMany({
        where: { id: run.id, ...stale },
        data: { heartbeatAt: now },
      });
      if (claimed.count === 0) continue;
      let recovered;
      try {
        recovered = await executor.recover({ runId: run.id, backend: run.executionBackend, id: run.id });
      } catch (err) {
        reconcilerLog.error({ err, runId: run.id }, "durable run recovery failed");
        continue;
      }
      if (recovered.state === "active" || recovered.state === "terminal") continue;
      reason = recovered.reason ?? "Durable backend reported the run lost.";
      const result = await db.run.updateMany({
        where: { id: run.id, executionManaged: true, status: { in: ["pending", "running"] } },
        data: { status: "lost", error: reason, finishedAt: now },
      });
      lost += result.count;
      continue;
    }
```

The final `updateMany` in this branch uses the status-only filter (not
`...stale`) because the claim just refreshed `heartbeatAt`, so the stale
predicate no longer matches. Include `executionBackend: true` in the
`candidates` query's selection (it is a scalar on `Run`, so the existing
`findMany` with `include` already returns it — verify with the typecheck).

- [ ] **Step 4: Run the reconciler tests**

Run: `npx vitest run src/core/reconciler.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Write the failing recover integration test**

Append to `src/providers/executor/dbos.database.test.ts`'s describe block:

```ts
it("recover(): reports active for its own live workflow, terminal for a finished one, lost for an unknown id", async () => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const llm = scriptedLlm([toolCall("t"), finalAnswer("ok")], { turn: 2, open });
  executor = build(llm);
  await executor.launch();
  const run = await db.run.create({ data: { agentId, executionManaged: true } });
  const started = executor.start(run.id);
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (llm.calls.length === 2) {
        clearInterval(poll);
        resolve();
      }
    }, 20);
  });

  const live = await executor.recover({ runId: run.id, backend: DBOS_BACKEND, id: run.id });
  expect(live).toEqual({ state: "active" });

  release();
  await started;
  const done = await executor.recover({ runId: run.id, backend: DBOS_BACKEND, id: run.id });
  expect(done).toEqual({ state: "terminal" });

  const unknown = await executor.recover({ runId: "nope", backend: DBOS_BACKEND, id: "nope" });
  expect(unknown.state).toBe("lost");
});

it("recover(): marks the run failed when the workflow finished but the row never went terminal", async () => {
  const llm = scriptedLlm([finalAnswer("ok")]);
  executor = build(llm);
  await executor.launch();
  const run = await db.run.create({ data: { agentId, executionManaged: true } });
  await executor.start(run.id);
  // Simulate a lost terminal write.
  await db.run.update({ where: { id: run.id }, data: { status: "running", finishedAt: null } });

  const result = await executor.recover({ runId: run.id, backend: DBOS_BACKEND, id: run.id });

  expect(result).toEqual({ state: "terminal" });
  const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  expect(after.status).toBe("failed");
  expect(after.error).toContain("without persisting a terminal run state");
});
```

- [ ] **Step 6: Implement `recover`**

Add to `DbosExecutor` in `src/providers/executor/dbos.ts` (import
`decideRecovery` from `./dbos-status.js` and the handle/result types from
`./types.js`):

```ts
  /**
   * Answer the reconciler for a stale run. Never relaunches: `resume`
   * re-drives the existing workflow from its last completed step, which is
   * the same thing launch() does for this executor's own workflows.
   */
  async recover(handle: PersistedExecutionHandle): Promise<ExecutionRecoveryResult> {
    if (handle.backend !== DBOS_BACKEND) {
      return { state: "lost", reason: `DbosExecutor cannot recover backend "${handle.backend}".` };
    }
    if (!this.launched) await this.launch();
    const status = await DBOS.getWorkflowStatus(handle.id);
    const row = await this.db.run.findUnique({ where: { id: handle.runId }, select: { status: true } });
    const runIsTerminal = !!row && !["pending", "running"].includes(row.status);
    const decision = decideRecovery(status, runIsTerminal, this.config.executorId);

    switch (decision.action) {
      case "active":
        return { state: "active" };
      case "resume": {
        dbosLog.warn({ runId: handle.runId, owner: status?.executorId }, "adopting orphaned durable run");
        const resumed = await DBOS.resumeWorkflow<void>(handle.id);
        void resumed.getResult().catch((err) => dbosLog.error({ err, runId: handle.runId }, "adopted run failed"));
        return { state: "active" };
      }
      case "terminal":
        return { state: "terminal" };
      case "mark-failed":
        await this.db.run.updateMany({
          where: { id: handle.runId, status: { in: ["pending", "running"] } },
          data: { status: "failed", error: decision.error, finishedAt: new Date() },
        });
        return { state: "terminal" };
      case "lost":
        return { state: "lost", reason: decision.reason };
    }
  }
```

`resumeWorkflow` runs the workflow on this executor: the module-level
`activeExecutor` must be this instance, which `launch()` guarantees. If the SDK
rejects `resumeWorkflow` for a PENDING workflow (only SUCCESS/ERROR/CANCELLED
allowed), fall back to `DBOS.cancelWorkflow(id)` followed by
`DBOS.resumeWorkflow(id)` and note the finding in the commit message.

- [ ] **Step 7: Run both suites**

Run: `npx vitest run src/providers/executor/dbos.database.test.ts src/core/reconciler.test.ts`
Expected: PASS.

- [ ] **Step 8: Lint, format, commit**

```bash
npm run lint && npm run format:check && npm run typecheck
git add src/providers/executor/dbos.ts src/providers/executor/dbos.database.test.ts src/core/reconciler.ts src/core/reconciler.test.ts
git commit -m "feat(executor): DBOS recover() with orphan adoption; reconciler consults durable backends before reaping"
```

---

### Task 7: Executor factory and composition-root wiring

**Files:**

- Create: `src/providers/executor/build.ts`
- Create: `src/providers/executor/build.test.ts`
- Modify: `src/providers/executor/index.ts`
- Modify: `src/cli.ts:89-94` and `src/cli.ts:405-425` (`assertInProcessExecutor`, `scheduler`)
- Modify: `src/mcp/index.ts:73-91` (`buildMcpProviders`) and the shutdown path in `startMcp`

**Interfaces:**

- Consumes: `InProcessExecutor`, `DbosExecutor`, `loadDbosConfig`, `ProviderConfig`.
- Produces: `buildExecutor(config: Pick<ProviderConfig, "executor">, providers: Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets">, db?: PrismaClient, env?: NodeJS.ProcessEnv): Executor`.

- [ ] **Step 1: Write the failing factory test**

Create `src/providers/executor/build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NativeEngine } from "../../core/engine-native.js";
import type { LlmProvider } from "../llm/types.js";
import type { Datastore } from "../datastore/types.js";
import type { SecretCipher } from "../secrets/types.js";
import { buildExecutor } from "./build.js";
import { InProcessExecutor } from "./in-process.js";
import { DbosExecutor } from "./dbos.js";

const llm = {} as LlmProvider;
const datastore = {} as Datastore;
const secrets = {} as SecretCipher;
const providers = { llm, engine: new NativeEngine(), datastore, secrets };

describe("buildExecutor", () => {
  it("builds the in-process executor by default", () => {
    expect(buildExecutor({ executor: "in-process" }, providers, undefined, {})).toBeInstanceOf(InProcessExecutor);
  });

  it("builds the DBOS executor when EXECUTOR=dbos and a database url is present", () => {
    const executor = buildExecutor({ executor: "dbos" }, providers, undefined, {
      DATABASE_URL: "postgresql://wardby:wardby@localhost:55432/wardby",
    });
    expect(executor).toBeInstanceOf(DbosExecutor);
    expect(typeof executor.launch).toBe("function");
    expect(typeof executor.close).toBe("function");
  });

  it("fails fast for EXECUTOR=dbos without any database url", () => {
    expect(() => buildExecutor({ executor: "dbos" }, providers, undefined, {})).toThrow(/DBOS_SYSTEM_DATABASE_URL/);
  });

  it("rejects an unknown executor kind", () => {
    expect(() => buildExecutor({ executor: "temporal" as never }, providers, undefined, {})).toThrow(
      /EXECUTOR "temporal"/,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/executor/build.test.ts`
Expected: FAIL, `./build.js` not found.

- [ ] **Step 3: Implement the factory**

Create `src/providers/executor/build.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type { ProviderRegistry } from "../index.js";
import { loadDbosConfig, type ProviderConfig } from "../../config/providers.js";
import { prisma as defaultDb } from "../../core/db.js";
import { InProcessExecutor } from "./in-process.js";
import { DbosExecutor } from "./dbos.js";
import type { Executor } from "./types.js";

/** Select the Executor adapter from EXECUTOR. Constructing never connects; call `launch?.()` for that. */
export function buildExecutor(
  config: Pick<ProviderConfig, "executor">,
  providers: Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets">,
  db: PrismaClient = defaultDb,
  env: NodeJS.ProcessEnv = process.env,
): Executor {
  switch (config.executor) {
    case "in-process":
      return new InProcessExecutor(providers, db);
    case "dbos":
      return new DbosExecutor(providers, loadDbosConfig(env), db);
    default:
      throw new Error(`EXECUTOR "${String(config.executor)}" has no adapter (use "in-process" or "dbos").`);
  }
}
```

Add `export * from "./build.js";` to `src/providers/executor/index.ts`.

- [ ] **Step 4: Run the factory test**

Run: `npx vitest run src/providers/executor/build.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the CLI scheduler**

In `src/cli.ts`: delete `assertInProcessExecutor` and its call. In `scheduler(...)`:

```ts
const config = loadProviderConfig();
const llm = buildLlmProvider();
const engine = buildEngine();
const secrets = buildSecrets();
const datastore = buildDatastore(secrets);
const executor = buildExecutor(config, { llm, engine, datastore, secrets }, prisma);
await executor.launch?.();
const reconciler = startReconciler({ db: prisma, executor });
const sched = startScheduler({ executor, db: prisma, scope });
```

and in its `shutdown` closure, after `sched.stop()` and the reconciler stop,
add `void executor.close?.();` (or `await` it if the closure is async). Import
`buildExecutor` from `./providers/executor/index.js` and drop the now-unused
`InProcessExecutor` import if nothing else in `cli.ts` uses it. If `wardby run`
(the attended path) uses `InProcessExecutor` elsewhere, leave that call alone:
attended runs stay in-process by design.

- [ ] **Step 6: Wire the MCP composition root**

In `src/mcp/index.ts` `buildMcpProviders`:

```ts
const executor = buildExecutor(providerConfig, { llm, engine, datastore, secrets }, prisma);
```

In `startMcp`, after `const { providers } = buildMcpProviders();` add
`await providers.executor.launch?.();`, and in whichever shutdown/signal
handler the function already has for the HTTP transport add
`await providers.executor.close?.();`. If there is no shutdown handler on the
stdio path, add `process.once("SIGINT", () => void providers.executor.close?.())`
next to the existing stdio start.

- [ ] **Step 7: Full verification**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Expected: all green. Then a manual smoke with the local DB:

```bash
EXECUTOR=dbos npm run cli -- scheduler
```

Expected: logs `DBOS executor launched` and no error; Ctrl+C exits cleanly. With
`EXECUTOR=dbos` unset, the scheduler starts exactly as before.

- [ ] **Step 8: Commit**

```bash
git add src/providers/executor/build.ts src/providers/executor/build.test.ts src/providers/executor/index.ts src/cli.ts src/mcp/index.ts
git commit -m "feat(executor): buildExecutor factory; scheduler and MCP honour EXECUTOR=dbos with launch/close lifecycle"
```

---

### Task 8: Crash-resume acceptance test and documentation

**Files:**

- Modify: `src/providers/executor/dbos.database.test.ts`
- Modify: `README.md`
- Modify: `docs/security-deployment.md`
- Modify: `docs/private/2026-09-05-roadmap-mcp-native.md` (Phase 6 status line)

- [ ] **Step 1: Write the failing resume test**

Append to the describe block in `src/providers/executor/dbos.database.test.ts`.
It proves the headline guarantee: after an interruption mid-run, the resumed
workflow does not re-execute turn 1.

```ts
it("resumes an interrupted run from its last completed step without re-running earlier turns", async () => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const llm = scriptedLlm([toolCall("t"), finalAnswer("resumed")], { turn: 2, open });
  executor = build(llm);
  await executor.launch();
  const run = await db.run.create({ data: { agentId, executionManaged: true } });

  const firstAttempt = executor.start(run.id).catch(() => undefined);
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (llm.calls.length === 2) {
        clearInterval(poll);
        resolve();
      }
    }, 20);
  });
  // "Crash": tear DBOS down while turn 2 is in flight. Turn 1 and its tool
  // call are already recorded as completed steps.
  await executor.close();

  // "Restart": a fresh executor with the same executor id re-drives the
  // PENDING workflow at launch. Turn 2's script is now unblocked.
  release();
  await firstAttempt;
  const resumedLlm = scriptedLlm([toolCall("t"), finalAnswer("resumed")]);
  executor = build(resumedLlm);
  await executor.launch();
  const resumed = await executor.recover({ runId: run.id, backend: DBOS_BACKEND, id: run.id });
  expect(["active", "terminal"]).toContain(resumed.state);
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      void db.run.findUnique({ where: { id: run.id } }).then((row) => {
        if (row && row.status !== "running" && row.status !== "pending") {
          clearInterval(poll);
          resolve();
        }
      });
    }, 50);
  });

  const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  expect(after.status).toBe("succeeded");
  expect(after.finalText).toBe("resumed");
  // Turn 1 replayed from the record: the resumed LLM only ever served turn 2.
  expect(resumedLlm.calls).toHaveLength(1);
  expect(resumedLlm.calls[0].messages.some((m) => m.role === "tool")).toBe(true);
}, 30_000);
```

Expected behaviours to confirm against the SDK while making this pass (record
what you find in the commit message):

- `DBOS.shutdown({ workflowCompletionTimeoutMS })` returns after the timeout
  with the workflow still PENDING. If it instead waits indefinitely, shorten
  the timeout to 500 ms in `close()`.
- `DBOS.launch()` recovers PENDING workflows for the configured executor id.
  If the second `launch()` in the same process is a no-op because DBOS is
  already initialized (the `isInitialized()` guard), that is why the test
  also calls `recover()`, whose `resume` branch handles it. Either path must
  produce one turn-2 call and zero turn-1 calls on the new LLM.
- If the first attempt's hung step later completes and tries to record turn 2
  after the resumed run already did, DBOS raises a conflict inside that dead
  attempt. The `.catch(() => undefined)` on `firstAttempt` absorbs it.

- [ ] **Step 2: Run to verify current behaviour**

Run: `npx vitest run src/providers/executor/dbos.database.test.ts -t "resumes an interrupted run"`
Expected: FAIL or PASS depending on SDK shutdown semantics. If it passes first time, keep it — it is the acceptance test. If it fails, fix per the notes above; do not weaken the two `calls` assertions.

- [ ] **Step 3: Document**

README, after the "MCP server (Phase 4)" section:

```markdown
## Durable executor (Phase 6)

`EXECUTOR=in-process` (default) provides durability with a heartbeat and a
reconciler: a run whose process dies is reconciled to `lost`.

`EXECUTOR=dbos` runs each native agent run as a [DBOS](https://docs.dbos.dev)
durable workflow. Every LLM turn and tool call is a checkpointed step, so a
run interrupted by a crash or redeploy resumes from its last completed step
with no repeated spend for finished turns, and cancelling a run
(`tasks/cancel`, `stop`) takes effect at the next step. DBOS keeps its tables
in the `dbos` schema of `DATABASE_URL` (override with
`DBOS_SYSTEM_DATABASE_URL`); set `DBOS_EXECUTOR_ID` to a stable value per
long-lived instance so it re-drives its own interrupted runs at startup. A
stale run owned by an instance that never returns is adopted by whichever
reconciler sees it first. The at-least-once window is one step: a turn that
was mid-stream when the process died runs again on resume.
```

`docs/security-deployment.md`: add a short "Durable executor" subsection under
the runtime/operations material stating (1) DBOS tables are outside Prisma's
migration chain and are created by DBOS at launch, so the database role needs
`CREATE` on the `dbos` schema; (2) `DBOS_EXECUTOR_ID` must be unique per
instance; (3) rolling back to `EXECUTOR=in-process` is safe at any time —
in-flight DBOS runs are reconciled to `lost` after the heartbeat timeout
because no executor can recover them, and nothing else depends on the `dbos`
schema.

Roadmap: change the Phase 6 line in `docs/private/2026-09-05-roadmap-mcp-native.md`
to `✅ shipped (2026-09-..)` with one sentence pointing at this plan, and move
it from "Not started" to "Shipped".

- [ ] **Step 4: Final verification**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Also re-run the Prisma drift check from Task 3 once more; it must still print
`-- This is an empty migration.`

- [ ] **Step 5: Commit**

```bash
git add src/providers/executor/dbos.database.test.ts README.md docs/security-deployment.md
git commit -m "test(executor): crash-resume acceptance for DbosExecutor; document EXECUTOR=dbos"
```

(`docs/private/` is git-ignored; edit it but it will not appear in the commit.)

---

## Out of scope (deliberately)

- Coding-agent (Phase 5) runs: `ContainerExecutor` owns those; `executeRun`'s
  coding branch still fails closed under DBOS exactly as under in-process.
- DBOS queues, rate limiting, or scheduling: wardby's scheduler and budget
  groups already own concurrency and spend.
- Cross-instance recovery beyond the reconciler adoption path (Task 6). A
  DBOS Conductor deployment is a later option, not a requirement.
- Making `EXECUTOR=dbos` the default. It stays opt-in until it has run a real
  fleet for a while.

## Self-review

- **Spec coverage.** Roadmap Phase 6: "resumes from the last completed step" →
  Tasks 1, 2, 5, 8. Phase 2 design: "behind the Executor seam, no scheduler or
  CLI change" → the scheduler and `dispatchRun` are untouched; only composition
  roots change (Task 7). "`ExecutorKind = in-process | dbos`" already exists;
  Task 7 makes it real. "Never let both [DBOS and an engine checkpointer]
  silently own durability" → the native engine has no checkpointer of its own;
  `StepRunner` is the single seam.
- **Placeholders.** None; every code step is complete. Two places ask the
  implementer to mirror existing test-helper names (Tasks 2 and 6) because those
  helpers are already in the files being edited.
- **Type consistency.** `StepRunner`/`runStepInline` (Task 1) are consumed by
  Task 2 and Task 5 under the same names. `DBOS_BACKEND`, `DbosExecutor`,
  `decideRecovery`, `buildExecutor`, `launch`/`close` are used identically across
  Tasks 4 through 8. `executeRun`'s fifth parameter is `step` everywhere.
