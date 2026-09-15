# DBOS Run-Ownership-Lost Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline execution — not subagent-driven). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `DbosExecutor` run loses a concurrent-attempt race for the same DBOS workflow (the SDK's `DBOSWorkflowConflictError`), stop writing that `Run` row `failed` — recognize it as "another execution legitimately owns advancing this run" and leave the row alone so the real winner's outcome can still land.

**Architecture:** Mirrors the existing `DBOSWorkflowCancelledError` → `RunCancelledError` translation already in `src/providers/executor/dbos.ts`'s `dbosStep`. Add a sibling `RunOwnershipLostError` next to the existing `RunCancelledError` in `src/core/runner.ts`, translate the SDK's conflict error into it at the same step boundary, and give `executeRun`'s defensive backstop a third branch: on `RunOwnershipLostError`, skip the terminal write entirely (today it unconditionally writes `cancelled` or `failed`) and just return the run's current real state.

**Tech Stack:** TypeScript, Vitest, `@dbos-inc/dbos-sdk` (already a dependency — `DBOSWorkflowConflictError` is a real exported class, `constructor(workflowID: string)`, importable and instantiable in a test with no DB/DBOS runtime needed).

**Spec:** No separate spec doc — this was scoped directly in conversation (see `docs/private/2026-09-05-roadmap-mcp-native.md`'s Phase 6 entry, "Still-open follow-up," for the background) after reading the exact code paths involved. This plan document is the design record.

## Global Constraints

- Never retry a DBOS step (`retriesAllowed: false` stays as-is) — unaffected by this change.
- `finishRun`'s conditional `updateMany` (`WHERE status IN ('pending','running')`) is the existing mechanism that lets "whoever writes first, for a row still in flight, wins" — this plan adds a case where an attempt writes **nothing at all**, it does not change `finishRun` itself.
- Every new error class and behavior must be covered by a real, deterministic unit test — no reliance on timing-sensitive real DBOS races (a genuine step-level conflict is very hard to reproduce on demand against live Postgres; both tasks below use direct construction/mocking of the SDK's own error classes instead, which is fully deterministic).

---

## Why this matters (read this before Task 1)

Traced precisely in conversation, verified against the actual SDK source
(`node_modules/@dbos-inc/dbos-sdk/dist/src/system_database.js` and
`dbos-executor.js`) and reevo's own code:

- `executeRun` (`src/core/runner.ts`) moves a `Run` row from `pending` to
  `running` (line 300) before calling the engine, then on success calls
  `finishRun` — a **conditional** `updateMany` that only touches rows still
  in `pending`/`running` (`DRIVABLE`, line 141). This is already safe against
  a genuine "someone else already finished it" race: if the row is already
  terminal, the conditional update is a no-op and the real terminal row is
  read back and returned untouched (see the existing test "lets the first
  terminal write win" in `runner.test.ts`).
- The actual gap is narrower and worse than "clobbering an already-finished
  row": it's **a loser prematurely finishing a row the winner is still
  legitimately advancing**. `executeRun`'s defensive backstop (line
  493–504) catches _any_ uncaught error and unconditionally calls
  `finishRun(db, runId, { status: ... "failed" ..., ... })`. Since the row
  is still `running` (DRIVABLE) at that point — the winner hasn't finished
  yet — this write **succeeds**, and permanently terminates the row. When
  the winner later tries to record its own real result, `finishRun`'s own
  conditional update now finds the row no longer DRIVABLE and silently
  no-ops, so **the winner's real outcome is never recorded** — the run is
  stuck showing the loser's spurious `failed`.
- `DBOSWorkflowConflictError` (thrown by the DBOS SDK when two attempts race
  to checkpoint the same workflow step, verified in
  `system_database.js:recordOperationResultInternal`) is exactly the signal
  that "I am the loser of such a race." Today `dbosStep`
  (`src/providers/executor/dbos.ts`) only translates
  `DBOSWorkflowCancelledError` into a `RunCancelledError` the backstop
  already knows how to treat specially (`cancelled`, not `failed`) — a
  conflict error falls through untranslated and hits the generic `failed`
  branch, triggering the bug above.
- The other place this SDK error can appear — DBOS's own internal
  workflow-completion recording (`dbos-executor.js:535`) — is **already
  handled by the SDK itself** (it releases and aborts the losing attempt
  silently, verified by reading that code path). Nothing to fix there; this
  plan only closes the mid-step gap in `dbosStep`.

---

## Task 1: `RunOwnershipLostError` + backstop handling in the runner

**Files:**

- Modify: `src/core/runner.ts:148` (next to `RunCancelledError`), and the backstop catch block at `src/core/runner.ts:493-504`
- Test: `src/core/runner.test.ts`

**Interfaces:**

- Produces: `export class RunOwnershipLostError extends Error` (same shape as `RunCancelledError`: `constructor(message: string)`, sets `this.name = "RunOwnershipLostError"`). `dbosStep` (Task 2) throws this; `executeRun`'s backstop catches it by `instanceof`.

- [ ] **Step 1: Write the failing test**

Add to `src/core/runner.test.ts`, in the same `describe` block as the existing
`"persists a cancelled status (not failed) when the backstop catches a RunCancelledError"` test (find it via that exact string), right after it:

```typescript
it("leaves a run untouched (not failed) when the backstop catches a RunOwnershipLostError, so the real winner can still finish it", async () => {
  const db = pendingRun();
  const run = await db.run.create({ data: { agentId: "a1" } });
  const engine: Engine = {
    async run() {
      throw new RunOwnershipLostError("Lost ownership of the durable workflow: another execution is advancing it.");
    },
  };

  const result = await executeRun(
    run.id,
    { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
    db,
  );

  // The loser writes nothing: the row is still exactly where executeRun's
  // own pending->running transition left it, not "failed".
  expect(result.status).toBe("running");
  expect(result.error).toBeNull();
  expect(result.finishedAt).toBeNull();

  // Prove the winner can still land its real result afterward — this is
  // the actual bug this fixes: today's unconditional "failed" write would
  // make this second call a no-op (finishRun only updates DRIVABLE rows).
  const winnerEngine = fakeEngine({
    status: "succeeded",
    finalText: "winner finished",
    turns: 1,
    usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 },
  });
  const winnerResult = await executeRun(
    run.id,
    { llm: noopLlm, engine: winnerEngine, datastore: fakeDatastore(), secrets: noopSecretCipher, memory: fakeMemory() },
    db,
  );
  expect(winnerResult.status).toBe("succeeded");
  expect(winnerResult.finalText).toBe("winner finished");
});
```

Also add `RunOwnershipLostError` to the existing import line at the top of
`src/core/runner.test.ts` (find the line that currently reads
`import { executeRun, runAgent, RunCancelledError, type RunnerDb } from "./runner.js";`
and add it there):

```typescript
import { executeRun, runAgent, RunCancelledError, RunOwnershipLostError, type RunnerDb } from "./runner.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/runner.test.ts -t "RunOwnershipLostError"`
Expected: FAIL — `RunOwnershipLostError` is not exported from `./runner.js` (TypeScript/import error), since it does not exist yet.

- [ ] **Step 3: Write minimal implementation**

In `src/core/runner.ts`, right after the existing `RunCancelledError` class
(find it via `export class RunCancelledError extends Error {`):

```typescript
/**
 * Raised when a run's step boundary observed a DBOS workflow-conflict
 * (another execution already owns advancing this workflow — see
 * DbosExecutor's `dbosStep`). `executeRun`'s backstop must not write
 * anything for this: the row is still legitimately in flight under the
 * winning execution, and a "failed" write here would permanently block that
 * winner's real result from ever being recorded (finishRun only updates a
 * row still in pending/running).
 */
export class RunOwnershipLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunOwnershipLostError";
  }
}
```

Then update the backstop catch block (find it via the comment
`// Defensive backstop: the engine is expected to catch its own errors`):

```typescript
  } catch (err) {
    // Defensive backstop: the engine is expected to catch its own errors
    // and return a "failed" EngineResult, but an unexpected throw here
    // (a real bug, or tool-loading failing outside the per-tool try above)
    // must still never leave the run dangling in "running". A cancellation
    // is not a failure: it carries the operator's own reason. A lost
    // ownership race is not a failure either: another execution already
    // owns finishing this run correctly, so this attempt must write
    // nothing and just report the row's real (still non-terminal) state.
    if (err instanceof RunOwnershipLostError) {
      return db.run.findUniqueOrThrow({ where: { id: runId } });
    }
    return finishRun(db, runId, {
      status: err instanceof RunCancelledError ? "cancelled" : "failed",
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date(),
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/runner.test.ts -t "RunOwnershipLostError"`
Expected: PASS

- [ ] **Step 5: Run the full runner test file to check for regressions**

Run: `npx vitest run src/core/runner.test.ts`
Expected: All tests PASS (same count as before, plus the one new test).

- [ ] **Step 6: Commit**

```bash
git add src/core/runner.ts src/core/runner.test.ts
git commit -m "$(cat <<'EOF'
feat(runner): add RunOwnershipLostError, don't write failed on a lost DBOS race

executeRun's backstop previously wrote every uncaught error as "failed"
except RunCancelledError. A DBOS workflow-conflict loser hit that generic
branch, permanently terminating a row the real winner was still legitimately
advancing (finishRun only updates rows still pending/running, so the
winner's later write would then silently no-op). RunOwnershipLostError gets
its own backstop branch: write nothing, just report the row's current state.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 2: Translate `DBOSWorkflowConflictError` in `dbosStep`

**Files:**

- Modify: `src/providers/executor/dbos.ts` (the `dbosStep` const)
- Create: `src/providers/executor/dbos-step.test.ts` (new — a pure unit test with no `DATABASE_URL` requirement, unlike `dbos.database.test.ts`)

**Interfaces:**

- Consumes: `RunOwnershipLostError` from `../../core/runner.js` (Task 1). `DBOS.runStep` and `DbosErrors.DBOSWorkflowConflictError` from `@dbos-inc/dbos-sdk` (already imported in `dbos.ts` as `DBOS, Error as DbosErrors`).
- Produces: `dbosStep` becomes `export const dbosStep: StepRunner = ...` (currently unexported) so Task 2's test can call it directly without going through the full DB-backed `DbosExecutor`.

- [ ] **Step 1: Write the failing test**

Create `src/providers/executor/dbos-step.test.ts`:

```typescript
import { DBOS, Error as DbosErrors } from "@dbos-inc/dbos-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunOwnershipLostError } from "../../core/runner.js";
import { dbosStep } from "./dbos.js";

/**
 * Unit-level (no DATABASE_URL/DBOS.launch() needed): DBOSWorkflowConflictError
 * is a plain class the SDK exports, constructible and throwable without a
 * live connection. DBOS.runStep is a static method — vi.spyOn patches the
 * one shared class object dbos.ts's own DBOS import also sees.
 */
describe("dbosStep", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("translates a DBOSWorkflowConflictError into RunOwnershipLostError instead of letting it propagate raw", async () => {
    vi.spyOn(DBOS, "runStep").mockRejectedValueOnce(new DbosErrors.DBOSWorkflowConflictError("wf-1"));

    await expect(dbosStep("turn", async () => "unused")).rejects.toThrow(RunOwnershipLostError);
  });

  it("still lets an unrelated error through unchanged", async () => {
    vi.spyOn(DBOS, "runStep").mockRejectedValueOnce(new Error("boom"));

    await expect(dbosStep("turn", async () => "unused")).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/executor/dbos-step.test.ts`
Expected: FAIL — `dbosStep` is not exported from `./dbos.js` (TypeScript/import error).

- [ ] **Step 3: Write minimal implementation**

In `src/providers/executor/dbos.ts`, find:

```typescript
const dbosStep: StepRunner = async (name, fn) => {
  try {
    return await DBOS.runStep(fn, { name, retriesAllowed: false });
  } catch (err) {
    if (err instanceof DbosErrors.DBOSWorkflowCancelledError) {
      const reason = cancellationReasons.get(err.workflowID);
      throw new RunCancelledError(`Run cancelled: ${reason ?? "no reason given"}`);
    }
    throw err;
  }
};
```

Replace with:

```typescript
export const dbosStep: StepRunner = async (name, fn) => {
  try {
    return await DBOS.runStep(fn, { name, retriesAllowed: false });
  } catch (err) {
    if (err instanceof DbosErrors.DBOSWorkflowCancelledError) {
      const reason = cancellationReasons.get(err.workflowID);
      throw new RunCancelledError(`Run cancelled: ${reason ?? "no reason given"}`);
    }
    if (err instanceof DbosErrors.DBOSWorkflowConflictError) {
      throw new RunOwnershipLostError(`Lost ownership of the durable workflow: ${err.message}`);
    }
    throw err;
  }
};
```

Add `RunOwnershipLostError` to this file's existing runner import (find the
line `import { executeRun, RunCancelledError, type RunnerDb } from "../../core/runner.js";`):

```typescript
import { executeRun, RunCancelledError, RunOwnershipLostError, type RunnerDb } from "../../core/runner.js";
```

Also update this function's own doc comment (currently says it only handles
`DBOSWorkflowCancelledError`):

```typescript
/**
 * Bind the engine's step boundary to a DBOS checkpointed step. Never
 * retried: a retry would re-spend.
 *
 * Translates two DBOS SDK signals into the runner's own vocabulary so
 * executeRun's backstop can tell them apart from a real failure:
 * - `DBOSWorkflowCancelledError` (the operator called stop()) becomes
 *   `RunCancelledError`, recorded as `cancelled` with the operator's reason.
 * - `DBOSWorkflowConflictError` (this execution lost a race to checkpoint
 *   this workflow's step — another execution owns it) becomes
 *   `RunOwnershipLostError`, which the backstop writes nothing for at all.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/executor/dbos-step.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Run the broader executor test suite to check for regressions**

Run: `npx vitest run src/providers/executor`
Expected: All tests PASS. (`dbos.database.test.ts` will skip if `DATABASE_URL` is unset in this environment — that's expected and unrelated to this change; `dbos-step.test.ts` and `dbos-status.test.ts` run regardless.)

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/providers/executor/dbos.ts src/providers/executor/dbos-step.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): translate DBOSWorkflowConflictError into RunOwnershipLostError

dbosStep already translated DBOSWorkflowCancelledError so executeRun's
backstop could record "cancelled" instead of "failed". A workflow-conflict
loser had no such translation and fell through to the generic failed
branch. Exports dbosStep so this is unit-testable by mocking DBOS.runStep
directly, with no DATABASE_URL/live DBOS connection required.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 3: Update the roadmap and status table once Tasks 1–2 are done

**Already done as of writing this plan (2026-09-14), before any code
landed:** both docs already reference this plan by name
(`[[2026-09-14-dbos-run-ownership-lost]]`) and are worded as "planned, not
yet implemented" — see the Phase 6 entry in
`docs/private/2026-09-05-roadmap-mcp-native.md` and the Phase 6 row in
`docs/private/2026-09-14-roadmap-status-table.md`. **This task is only
the follow-up flip to "shipped" after Tasks 1–2 actually land** — don't
mark it shipped before the code and tests are in, per this project's own
"verify doc claims against code" rule.

**Files:**

- Modify: `docs/private/2026-09-05-roadmap-mcp-native.md` (Phase 6 entry)
- Modify: `docs/private/2026-09-14-roadmap-status-table.md` (Phase 6 row)

Both are git-ignored (`docs/private/`) — no commit needed for these two, just save the files.

- [ ] **Step 1: Update the roadmap's Phase 6 entry**

In `docs/private/2026-09-05-roadmap-mcp-native.md`, find the sentence starting
`**Still-open follow-up, now planned (2026-09-14, not yet implemented):**`
and replace it with:

```markdown
**Follow-up shipped 2026-09-14** (plan: [[2026-09-14-dbos-run-ownership-lost]]): a concurrent-attempt collision (loser's `DBOSWorkflowConflictError`) previously became a `failed` write, which could permanently block the winning execution's real result from ever being recorded. `dbosStep` now translates it into `RunOwnershipLostError`, which `executeRun`'s backstop treats as "write nothing, another execution owns this" rather than a failure.
```

- [ ] **Step 2: Update the status table's Phase 6 row**

In `docs/private/2026-09-14-roadmap-status-table.md`, find the Phase 6 row
and replace its Notes cell (the text after the last `|`) with:

```markdown
Merged to `main` (`6e0f903`). Concurrent-attempt collision handling shipped 2026-09-14 — see [[2026-09-14-dbos-run-ownership-lost]].
```

- [ ] **Step 3: No commit** — both files are git-ignored; saving them is the whole step.
