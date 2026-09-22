# Phase 12 Foundations: Shallow Clones and a Coding Concurrency Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make coding-agent clones shallow and add a database-backed cap on concurrent coding runs with a FIFO queue, so both the existing Docker launcher and the future Kubernetes launcher get bounded, crash-safe concurrency and smaller workspaces.

**Architecture:** The clone change is one flag in `GitVcsProvider.prepareWorkspace` (`--depth 1`); the finalizer only compares against `baseCommit` and the new commit's parent, and the push step compares SHAs, so no history walk is needed. The concurrency gate lives inside the existing `PrismaContainerExecutionStore.claimProvisioning` transaction: an advisory lock serializes claimers, "slots in use" is derived from existing columns (coding runs with a `jobBackend` whose run is `pending`/`running`), and a run over the cap gets `CodingRun.queuedAt` instead of a claim. A new `drainCodingQueue` times out stale queued runs and starts the oldest ones into free slots; it runs on the scheduler leader's tick and immediately in any process whose run just finished. The reconciler stops treating queued runs as orphans.

**Tech Stack:** TypeScript / Node 22+ (Node 24 pinned locally), Prisma 6 + PostgreSQL, Vitest, git.

**Spec:** `docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md` (this plan implements §4 "Clone" and §6 "Concurrency and queueing"). This is **Plan 1 of 3**: Plan 2 is the Kubernetes launcher and `kind` harness (including the per-agent workspace size, moved there because it only pays off with disk-backed volumes); Plan 3 is GKE deployment and acceptance.

## Global Constraints

- **Never commit to `main`.** Implement on a branch (Task 0 creates `phase-12-foundations`).
- **CLAUDE.md "Database / Prisma — STRICT" applies (Task 2):** never `prisma db push`; never edit an applied migration; hand-write migration SQL; every `CREATE INDEX` needs a matching `@@index`; run the drift check and `npx prisma validate`.
- **Local database credentials:** the running local Postgres was created before the rename and uses user/database `reevo` (see `DATABASE_URL` in `.env.local`), while `deploy/local/docker-compose.yml` and CLAUDE.md now say `wardby`. Run the drift check with the credentials from `.env.local`, as written in Task 2. Do not recreate the database.
- **No scheduling-logic changes beyond what a task specifies.** `claimDueRun`, `findDueCandidates`, lease logic, and cron are untouched.
- **Clean-room (CLEANROOM.md):** write everything from this plan and the spec; copy no external code.
- **Behavior change to call out in the PR:** existing Docker deployments get a default cap of 4 concurrent coding runs (`CODING_MAX_CONCURRENT`).
- **Verification for every task:** `npm run typecheck`, `npm run lint`, `npm test` (with `npm run db:up` so database-gated tests run; `vitest.setup.ts` loads `.env.local`), `npm run format:check`.
- **Commit messages end with:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4`.

## File structure

| File                                                                                                    | Responsibility                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/providers/vcs/git.ts` (modify)                                                                     | Add `--depth 1` to the clone.                                                        |
| `src/providers/vcs/git.test.ts` (modify)                                                                | Assert the depth flag.                                                               |
| `src/providers/vcs/git-shallow.integration.test.ts` (new)                                               | Real-git proof that a depth-1 clone can commit on `baseCommit` and push.             |
| `prisma/schema.prisma`, `prisma/migrations/20260922010000_coding_run_queued_at/migration.sql` (new)     | `CodingRun.queuedAt` + index.                                                        |
| `src/config/providers.ts`, `src/config/providers.test.ts` (modify)                                      | `loadCodingConcurrencyConfig` (`CODING_MAX_CONCURRENT`, `CODING_QUEUE_TIMEOUT_SEC`). |
| `src/providers/executor/container.ts` (modify)                                                          | `ProvisioningClaim` outcome, capped `claimProvisioning`, `onSlotReleased` hook.      |
| `src/providers/executor/container.test.ts`, `container.database.test.ts` (modify)                       | Queued-path unit tests; racing-claims database test.                                 |
| `src/core/reconciler.ts` (modify), `src/core/reconciler.coding-queue.database.test.ts` (new)            | Queued runs are not orphans.                                                         |
| `src/core/coding-queue.ts`, `src/core/coding-queue.database.test.ts` (new)                              | `drainCodingQueue`: timeout + FIFO start into free slots.                            |
| `src/core/scheduler.ts`, `src/serve.ts`, `src/cli.ts`, `src/providers/executor/composition.ts` (modify) | Wire the drain into the leader tick and the slot-released hook.                      |
| `src/mcp/tools/runs.ts`, `src/mcp/tools/runs.test.ts` (modify)                                          | `get_run` shows `codingQueuedAt` for a queued run.                                   |
| `.env.example`, `docs/coding-worker-isolation.md` (modify)                                              | Document the two settings and the queue.                                             |

---

### Task 0: Branch

- [ ] **Step 1: Create the implementation branch from the spec branch**

```bash
git switch spec-phase-12-kubernetes-launcher
git switch -c phase-12-foundations
```

Expected: `Switched to a new branch 'phase-12-foundations'`.

---

### Task 1: Shallow clones

**Files:**

- Modify: `src/providers/vcs/git.ts` (the `clone` argument list in `prepareWorkspace`, ~line 300)
- Modify: `src/providers/vcs/git.test.ts` (add one test after "prepares separate Git metadata…", ~line 212)
- Create: `src/providers/vcs/git-shallow.integration.test.ts`

**Interfaces:** Produces no new API. Behavior: every workspace clone (fresh and revision-in-place continuation) is depth 1.

- [ ] **Step 1: Write the failing unit test**

Add to the top-level `describe` in `src/providers/vcs/git.test.ts`, directly after the test named `"prepares separate Git metadata at an immutable base commit without leaking the token"`:

```typescript
it("clones shallowly: depth 1, since the worker never sees history and finalization needs only baseCommit", async () => {
  const { provider, git, input } = await harness();
  await provider.prepareWorkspace(input);
  const clone = git.calls.find((call) => call.args.includes("clone"))!;
  const depthAt = clone.args.indexOf("--depth");
  expect(depthAt).toBeGreaterThan(-1);
  expect(clone.args[depthAt + 1]).toBe("1");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/providers/vcs/git.test.ts -t "clones shallowly"`
Expected: FAIL (`expected -1 to be greater than -1`).

- [ ] **Step 3: Add the flag**

In `src/providers/vcs/git.ts`, in `prepareWorkspace`, change the clone arguments from:

```typescript
            "clone",
            "--no-checkout",
            "--single-branch",
            "--no-tags",
```

to:

```typescript
            "clone",
            "--no-checkout",
            "--single-branch",
            "--no-tags",
            // History is never needed: the worker gets no Git metadata, the
            // finalizer compares only against baseCommit and the new commit's
            // parent, and pushOnce compares SHAs. Depth 1 keeps large
            // repositories' history off the control plane's disk.
            "--depth",
            "1",
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run src/providers/vcs/git.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Write the real-git integration test**

This proves, against real git, the property the finalizer relies on: a depth-1 clone can commit on top of `baseCommit` and push to a new branch, and the pushed commit's parent is `baseCommit`. `--depth` is ignored for plain local paths, so the remote is addressed with a `file://` URL.

Create `src/providers/vcs/git-shallow.integration.test.ts`:

```typescript
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false"];

async function git(cwd: string, args: string[], gitDir?: string): Promise<string> {
  const prefix = gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${cwd}`] : [];
  const { stdout } = await run("git", [...IDENTITY, ...prefix, ...args], { cwd });
  return stdout.trim();
}

describe("depth-1 clone supports Wardby's finalize path (real git)", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("commits on baseCommit and pushes a new branch whose parent is baseCommit", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-shallow-"));
    roots.push(root);
    const seed = join(root, "seed");
    const remote = join(root, "remote.git");
    const workspace = join(root, "workspace");
    const meta = join(root, "meta");

    // A remote with three commits on main, so depth 1 genuinely truncates history.
    await run("git", ["init", "--initial-branch=main", seed]);
    for (const n of [1, 2, 3]) {
      await writeFile(join(seed, "file.txt"), `v${n}\n`);
      await git(seed, ["add", "file.txt"]);
      await git(seed, ["commit", "-m", `c${n}`]);
    }
    await run("git", ["clone", "--bare", seed, remote]);
    const baseCommit = await git(seed, ["rev-parse", "HEAD"]);

    // Mirror prepareWorkspace's clone shape.
    await run("git", [
      "clone",
      "--no-checkout",
      "--single-branch",
      "--no-tags",
      "--depth",
      "1",
      "--branch",
      "main",
      "--separate-git-dir",
      meta,
      `file://${remote}`,
      workspace,
    ]);
    await rm(join(workspace, ".git"), { force: true });
    expect(await git(workspace, ["rev-parse", "--is-shallow-repository"], meta)).toBe("true");
    expect(await git(workspace, ["rev-list", "--count", "HEAD"], meta)).toBe("1");

    await git(workspace, ["read-tree", "--reset", "-u", baseCommit], meta);
    await writeFile(join(workspace, "file.txt"), "changed\n");
    await git(workspace, ["add", "--all"], meta);
    await git(workspace, ["commit", "--no-verify", "-m", "Wardby run test"], meta);
    const commitSha = await git(workspace, ["rev-parse", "HEAD"], meta);
    expect(await git(workspace, ["rev-parse", "HEAD^"], meta)).toBe(baseCommit);

    await git(workspace, ["push", "origin", `${commitSha}:refs/heads/wardby/run-test`], meta);
    expect(await git(remote, ["rev-parse", "refs/heads/wardby/run-test"])).toBe(commitSha);
    expect(await git(remote, ["rev-parse", `${commitSha}^`])).toBe(baseCommit);
  });
});
```

- [ ] **Step 6: Run it**

Run: `npx vitest run src/providers/vcs/git-shallow.integration.test.ts`
Expected: PASS (1 test). If it fails on `push` with a shallow-related error, stop and report it: the design's assumption (spec §4, "The plan must verify") is wrong and the clone needs deepening.

- [ ] **Step 7: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`
Expected: all pass.

```bash
git add src/providers/vcs/git.ts src/providers/vcs/git.test.ts src/providers/vcs/git-shallow.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(vcs): clone coding workspaces at depth 1

The worker never receives Git metadata, the finalizer compares only
against baseCommit and the new commit's parent, and pushOnce compares
SHAs, so history is dead weight on the control plane's disk - often most
of a large repository's size. A real-git integration test proves a depth-1
clone can commit on baseCommit and push a branch whose parent is
baseCommit. Applies to fresh runs and revision-in-place continuations.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 2: `CodingRun.queuedAt` column

**Files:**

- Modify: `prisma/schema.prisma` (`model CodingRun`, ~line 343)
- Create: `prisma/migrations/20260922010000_coding_run_queued_at/migration.sql`

**Interfaces:** Produces `CodingRun.queuedAt: Date | null` (Prisma field `queuedAt`), indexed. Set when a run is queued for a slot; cleared when it claims one.

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, inside `model CodingRun`, add after the `budgetReservedUsd` line:

```prisma
  /// Phase 12 concurrency queue: set when start() found every coding slot
  /// taken (CODING_MAX_CONCURRENT), cleared when the run claims a slot. A
  /// pending run with queuedAt set is waiting, not orphaned.
  queuedAt          DateTime?
```

and add to the model's index block, after `@@index([failureCategory])`:

```prisma
  @@index([queuedAt])
```

- [ ] **Step 2: Hand-write the migration**

Create `prisma/migrations/20260922010000_coding_run_queued_at/migration.sql`:

```sql
-- Additive: Phase 12 coding concurrency queue. See
-- docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md §6.

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "queuedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CodingRun_queuedAt_idx" ON "CodingRun"("queuedAt");
```

- [ ] **Step 3: Apply locally and regenerate the client**

Run: `npm run db:up && npm run prisma:migrate && npm run prisma:generate`
Expected: `prisma migrate deploy` reports `20260922010000_coding_run_queued_at` applied; client generated.

- [ ] **Step 4: Drift check (must be clean)**

Uses the pre-rename local credentials from `.env.local` (see Global Constraints):

```bash
docker exec local-postgres-1 psql -U reevo -d reevo \
  -c "DROP DATABASE IF EXISTS reevo_shadow;" -c "CREATE DATABASE reevo_shadow;"
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://reevo:reevo@localhost:55432/reevo_shadow" \
  --script
docker exec local-postgres-1 psql -U reevo -d reevo -c "DROP DATABASE IF EXISTS reevo_shadow;"
npx prisma validate
```

Expected: `-- This is an empty migration.` and `The schema at prisma/schema.prisma is valid`. If the password in `.env.local` is not `reevo`, use the one from `DATABASE_URL` there.

- [ ] **Step 5: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`
Expected: all pass.

```bash
git add prisma/schema.prisma prisma/migrations/20260922010000_coding_run_queued_at
git commit -m "$(cat <<'EOF'
feat(db): add CodingRun.queuedAt for the coding concurrency queue

Nullable timestamp set when a coding run waits for a concurrency slot and
cleared when it claims one, plus an index for oldest-first dequeue.
Hand-written additive migration; drift check clean.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 3: Concurrency configuration

**Files:**

- Modify: `src/config/providers.ts` (after `loadContainerExecutorConfig`, ~line 118)
- Modify: `src/config/providers.test.ts`
- Modify: `.env.example` (after `CODING_DISK_MB=2048`)

**Interfaces:** Produces:

```typescript
export interface CodingConcurrencyConfig {
  maxConcurrent: number; // CODING_MAX_CONCURRENT, default 4
  queueTimeoutSec: number; // CODING_QUEUE_TIMEOUT_SEC, default 3600
}
export function loadCodingConcurrencyConfig(env?: NodeJS.ProcessEnv): CodingConcurrencyConfig;
```

- [ ] **Step 1: Write the failing tests**

In `src/config/providers.test.ts`, add `loadCodingConcurrencyConfig` to the import from `./providers.js`, and append:

```typescript
describe("loadCodingConcurrencyConfig", () => {
  it("defaults to 4 concurrent coding runs and a one-hour queue timeout", () => {
    expect(loadCodingConcurrencyConfig({})).toEqual({ maxConcurrent: 4, queueTimeoutSec: 3600 });
  });

  it("reads both settings", () => {
    expect(loadCodingConcurrencyConfig({ CODING_MAX_CONCURRENT: "12", CODING_QUEUE_TIMEOUT_SEC: "600" })).toEqual({
      maxConcurrent: 12,
      queueTimeoutSec: 600,
    });
  });

  it.each(["0", "-1", "1.5", "many"])("rejects CODING_MAX_CONCURRENT=%s", (value) => {
    expect(() => loadCodingConcurrencyConfig({ CODING_MAX_CONCURRENT: value })).toThrow(
      "CODING_MAX_CONCURRENT must be a positive integer.",
    );
  });

  it("rejects a non-positive CODING_QUEUE_TIMEOUT_SEC", () => {
    expect(() => loadCodingConcurrencyConfig({ CODING_QUEUE_TIMEOUT_SEC: "0" })).toThrow(
      "CODING_QUEUE_TIMEOUT_SEC must be a positive integer.",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/config/providers.test.ts -t loadCodingConcurrencyConfig`
Expected: FAIL (`loadCodingConcurrencyConfig is not a function` / import error).

- [ ] **Step 3: Implement**

In `src/config/providers.ts`, directly after `loadContainerExecutorConfig`:

```typescript
/**
 * Caps coding runs holding a concurrency slot across every control-plane
 * replica (enforced in Postgres, see PrismaContainerExecutionStore), and how
 * long a run may wait for one before failing with coding_queue_timeout.
 */
export interface CodingConcurrencyConfig {
  maxConcurrent: number;
  queueTimeoutSec: number;
}

export function loadCodingConcurrencyConfig(env: NodeJS.ProcessEnv = process.env): CodingConcurrencyConfig {
  return {
    maxConcurrent: optionalPositiveInteger(env.CODING_MAX_CONCURRENT, "CODING_MAX_CONCURRENT") ?? 4,
    queueTimeoutSec: optionalPositiveInteger(env.CODING_QUEUE_TIMEOUT_SEC, "CODING_QUEUE_TIMEOUT_SEC") ?? 3600,
  };
}
```

In `.env.example`, after the line `CODING_DISK_MB=2048`, add:

```dotenv
# Coding runs holding a slot at once, across all control-plane replicas
# (enforced in Postgres). Runs over the cap wait in a FIFO queue.
CODING_MAX_CONCURRENT=4
# Seconds a coding run may wait for a slot before failing (coding_queue_timeout).
CODING_QUEUE_TIMEOUT_SEC=3600
```

- [ ] **Step 4: Run to verify pass, full checks, commit**

Run: `npx vitest run src/config/providers.test.ts` then `npm run typecheck && npm run lint && npm run format:check`
Expected: all pass.

```bash
git add src/config/providers.ts src/config/providers.test.ts .env.example
git commit -m "$(cat <<'EOF'
feat(config): add CODING_MAX_CONCURRENT and CODING_QUEUE_TIMEOUT_SEC

Defaults: 4 concurrent coding runs, one-hour queue timeout. Consumed by
the concurrency gate and queue drain in the following commits.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 4: Capped `claimProvisioning` and the queued path

**Files:**

- Modify: `src/providers/executor/container.ts` (interface ~line 62, class ~line 81, `claimProvisioning` ~line 121, `execute` ~line 404)
- Modify: `src/providers/executor/container.test.ts` (`FakeStore.claimProvisioning` ~line 68; new tests)
- Modify: `src/providers/executor/container.database.test.ts` (new test)

**Interfaces:**

- Consumes: `CodingRun.queuedAt` (Task 2).
- Produces:

```typescript
export type ProvisioningClaim = "claimed" | "unavailable" | "queued";
// ContainerExecutionStore.claimProvisioning(runId: string, claimId: string): Promise<ProvisioningClaim>
// new PrismaContainerExecutionStore(db: PrismaClient, options?: { maxConcurrent?: number })
//   maxConcurrent undefined = no cap (keeps existing callers/tests unchanged).
```

A slot is in use when a `CodingRun` has a non-null `jobBackend` (the provisioning claim or the real job handle) and its `Run.status` is `pending` or `running`.

- [ ] **Step 1: Write the failing database test**

In `src/providers/executor/container.database.test.ts`, add a second `describe` block at the end of the file:

```typescript
describe.skipIf(!process.env.DATABASE_URL)("coding concurrency cap (PostgreSQL)", () => {
  const capSuffix = randomUUID();
  const capPrincipal = `cap-principal-${capSuffix}`;
  const capAgent = `cap-agent-${capSuffix}`;
  const runIds = [0, 1, 2, 3, 4].map((n) => `cap-run-${n}-${capSuffix}`);

  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agent.deleteMany({ where: { id: capAgent } });
    await db.principal.deleteMany({ where: { id: capPrincipal } });
  });

  it("admits exactly maxConcurrent of many racing claims and queues the rest", async () => {
    // Isolate from other coding runs in the shared local database.
    const otherActive = await db.codingRun.count({
      where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
    });
    const maxConcurrent = otherActive + 2;

    await db.principal.create({ data: { id: capPrincipal, subject: capPrincipal } });
    await db.agent.create({
      data: {
        id: capAgent,
        name: capAgent,
        systemPrompt: "code safely",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: capPrincipal,
      },
    });
    for (const id of runIds) {
      await db.run.create({ data: { id, agentId: capAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: id,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${id}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });
    }

    const store = new PrismaContainerExecutionStore(db, { maxConcurrent });
    const outcomes = await Promise.all(runIds.map((id) => store.claimProvisioning(id, `claim-${id}`)));

    expect(outcomes.filter((o) => o === "claimed")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "queued")).toHaveLength(3);
    const rows = await db.codingRun.findMany({ where: { runId: { in: runIds } } });
    for (const row of rows) {
      if (row.jobBackend) expect(row.queuedAt).toBeNull();
      else expect(row.queuedAt).toBeInstanceOf(Date);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/executor/container.database.test.ts -t "concurrency cap"`
Expected: FAIL — TypeScript/argument error on `new PrismaContainerExecutionStore(db, { maxConcurrent })`, or all five `true` results.

- [ ] **Step 3: Implement the capped claim**

In `src/providers/executor/container.ts`:

(a) Next to `PROVISIONING_BACKEND` (~line 25), add:

```typescript
/** Serializes concurrency-slot claims across replicas. Distinct from the OAuth client lock (7412901). */
const CODING_SLOT_LOCK_SQL = "SELECT 1 AS locked FROM pg_advisory_xact_lock(7412902)";
```

(b) Above `export interface ContainerExecutionStore`, add:

```typescript
/**
 * claimed: this caller owns provisioning. unavailable: someone else does, or
 * the run is no longer active. queued: every concurrency slot is taken; the
 * run stays pending with CodingRun.queuedAt set until drainCodingQueue
 * starts it.
 */
export type ProvisioningClaim = "claimed" | "unavailable" | "queued";
```

and change the interface member to:

```typescript
  claimProvisioning(runId: string, claimId: string): Promise<ProvisioningClaim>;
```

(c) Change the class constructor from:

```typescript
  constructor(private readonly db: PrismaClient) {}
```

to:

```typescript
  constructor(
    private readonly db: PrismaClient,
    private readonly options: { maxConcurrent?: number } = {},
  ) {}
```

(d) Replace the whole `claimProvisioning` method with:

```typescript
  async claimProvisioning(runId: string, claimId: string): Promise<ProvisioningClaim> {
    return this.db.$transaction(async (tx) => {
      const { maxConcurrent } = this.options;
      if (maxConcurrent !== undefined) {
        // Slot usage is derived from run state, never a separate counter: a
        // run that finishes, fails, is stopped, or is reconciled to lost stops
        // counting, so a crashed replica cannot leak a slot.
        await tx.$queryRawUnsafe(CODING_SLOT_LOCK_SQL);
        const active = await tx.codingRun.count({
          where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
        });
        if (active >= maxConcurrent) {
          const queued = await tx.codingRun.updateMany({
            where: { runId, jobBackend: null, queuedAt: null, run: { status: "pending" } },
            data: { queuedAt: new Date() },
          });
          if (queued.count === 1) return "queued";
          const alreadyQueued = await tx.codingRun.count({
            where: { runId, jobBackend: null, queuedAt: { not: null }, run: { status: "pending" } },
          });
          return alreadyQueued === 1 ? "queued" : "unavailable";
        }
      }
      const claimed = await tx.codingRun.updateMany({
        where: {
          runId,
          jobBackend: null,
          jobHandle: null,
          run: { status: { in: ["pending", "running"] } },
        },
        data: { jobBackend: PROVISIONING_BACKEND, jobHandle: claimId, queuedAt: null },
      });
      if (claimed.count === 0) return "unavailable";
      await tx.run.update({
        where: { id: runId },
        data: { status: "running", heartbeatAt: new Date() },
      });
      return "claimed";
    });
  }
```

(e) In `execute`, change:

```typescript
claimId = randomUUID();
if (!(await this.options.store.claimProvisioning(runId, claimId))) return;
```

to:

```typescript
claimId = randomUUID();
// "queued": every slot is taken; the run stays pending and
// drainCodingQueue starts it when one frees. "unavailable": another
// process owns provisioning, or the run is no longer active.
if ((await this.options.store.claimProvisioning(runId, claimId)) !== "claimed") return;
```

- [ ] **Step 4: Update the unit-test fake and add queued-path tests**

In `src/providers/executor/container.test.ts`:

(a) Import the type: add `type ProvisioningClaim,` to the existing import from `./container.js`.

(b) Replace `FakeStore.claimProvisioning` with:

```typescript
  /** When true, the next claims report every slot taken. */
  slotsFull = false;

  async claimProvisioning(_runId: string, claimId: string): Promise<ProvisioningClaim> {
    if (this.run.jobHandle || this.run.provisioningClaim) return "unavailable";
    if (this.slotsFull) return "queued";
    this.run.provisioningClaim = claimId;
    this.run.status = "running";
    return "claimed";
  }
```

(c) Add inside `describe("ContainerExecutor", ...)`, after the test `"does not duplicate work owned by another durable provisioning claim"`:

```typescript
it("leaves a run pending, with no workspace, session, or job, when every slot is taken", async () => {
  const created = await harness();
  created.store.slotsFull = true;
  await created.executor.start("run-1");
  expect(created.store.run.status).toBe("pending");
  expect(created.vcs.prepared).toBe(0);
  expect(created.sessions.creates).toBe(0);
  expect(created.jobs.launches).toBe(0);
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/providers/executor/container.test.ts src/providers/executor/container.database.test.ts`
Expected: PASS, including the existing test `"admits one provisioning owner…"`, whose assertion `[first, second].filter(Boolean)` must be updated in this step to `expect([first, second].filter((o) => o === "claimed")).toHaveLength(1);` because both outcomes are now truthy strings.

- [ ] **Step 6: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`
Expected: all pass. (`src/providers/executor/composition.ts` still constructs the store without a cap; Task 7 wires it.)

```bash
git add src/providers/executor/container.ts src/providers/executor/container.test.ts src/providers/executor/container.database.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): cap concurrent coding runs inside claimProvisioning

claimProvisioning now returns claimed | unavailable | queued. With a
maxConcurrent set, it takes an advisory lock and counts coding runs that
hold a slot (a jobBackend on a pending/running run); over the cap, the run
stays pending with CodingRun.queuedAt set instead of claiming. Slot usage
is derived from run state, so finishing, failing, stopping, or being
reconciled to lost frees a slot and a crashed replica cannot leak one.
A database test races five claims against a cap of two.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 5: Queued runs are not orphans

**Files:**

- Modify: `src/core/reconciler.ts` (the `stale` filter in `reconcileOnce`, ~line 46)
- Create: `src/core/reconciler.coding-queue.database.test.ts`

**Interfaces:** Consumes `CodingRun.queuedAt`. Behavior: the reconciler's "pending past the timeout" arm skips runs whose `CodingRun.queuedAt` is set; the queue timeout (Task 6) owns those.

- [ ] **Step 1: Write the failing database test**

Create `src/core/reconciler.coding-queue.database.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { reconcileOnce } from "./reconciler.js";

const db = new PrismaClient();
const suffix = randomUUID();
const principalId = `recon-q-principal-${suffix}`;
const agentId = `recon-q-agent-${suffix}`;
const queuedRun = `recon-q-queued-${suffix}`;
const orphanRun = `recon-q-orphan-${suffix}`;

describe.skipIf(!process.env.DATABASE_URL)("reconciler and the coding queue (PostgreSQL)", () => {
  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: [queuedRun, orphanRun] } } });
    await db.run.deleteMany({ where: { id: { in: [queuedRun, orphanRun] } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: principalId } });
    await db.$disconnect();
  });

  it("leaves a queued pending coding run alone but still reaps an unqueued one", async () => {
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await db.principal.create({ data: { id: principalId, subject: principalId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "code safely",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: principalId,
      },
    });
    for (const [id, queuedAt] of [
      [queuedRun, longAgo],
      [orphanRun, null],
    ] as const) {
      await db.run.create({ data: { id, agentId, executionManaged: true, startedAt: longAgo } });
      await db.codingRun.create({
        data: {
          runId: id,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${id}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
          queuedAt,
        },
      });
    }

    await reconcileOnce(db, new Date());

    expect((await db.run.findUniqueOrThrow({ where: { id: queuedRun } })).status).toBe("pending");
    expect((await db.run.findUniqueOrThrow({ where: { id: orphanRun } })).status).toBe("lost");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/reconciler.coding-queue.database.test.ts`
Expected: FAIL (`expected 'lost' to be 'pending'`).

- [ ] **Step 3: Implement**

In `src/core/reconciler.ts`, change the pending arm of `stale` from:

```typescript
      { status: "pending" as const, startedAt: { lt: cutoff } },
```

to:

```typescript
      {
        status: "pending" as const,
        startedAt: { lt: cutoff },
        // A coding run waiting for a concurrency slot is pending by design;
        // drainCodingQueue times those out (coding_queue_timeout) instead.
        OR: [{ codingRun: { is: null } }, { codingRun: { is: { queuedAt: null } } }],
      },
```

Also extend the file's header comment: after the bullet beginning "`pending` past the timeout", add the sentence: "Queued coding runs (`CodingRun.queuedAt` set) are excluded; the coding queue owns their timeout."

- [ ] **Step 4: Run the new test and the existing reconciler tests**

Run: `npx vitest run src/core/reconciler`
Expected: PASS (new test plus existing reconciler tests).

- [ ] **Step 5: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`

```bash
git add src/core/reconciler.ts src/core/reconciler.coding-queue.database.test.ts
git commit -m "$(cat <<'EOF'
fix(reconciler): don't reap coding runs waiting for a concurrency slot

The reconciler marks any pending run older than 45s as lost, which would
reap every queued coding run. Runs with CodingRun.queuedAt set are now
excluded; the coding queue's own timeout handles them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 6: `drainCodingQueue`

**Files:**

- Create: `src/core/coding-queue.ts`
- Create: `src/core/coding-queue.database.test.ts`

**Interfaces:**

- Consumes: `CodingRun.queuedAt`; `Executor` (`src/providers/executor/types.ts`, `start(runId): Promise<void>`); `markRunFailedFromExecutorError(db, runId, err)` from `src/core/dispatch.ts`.
- Produces:

```typescript
export const CODING_QUEUE_TIMEOUT_ERROR = "coding_queue_timeout";
export type CodingQueueDb = Pick<PrismaClient, "run" | "codingRun">;
export interface DrainCodingQueueOptions {
  db: CodingQueueDb;
  executor: Executor;
  maxConcurrent: number;
  queueTimeoutSec: number;
  now?: () => Date;
}
export interface DrainCodingQueueResult {
  timedOut: number;
  started: string[];
}
export async function drainCodingQueue(options: DrainCodingQueueOptions): Promise<DrainCodingQueueResult>;
```

Starts are fire-and-forget (`executor.start` resolves only when the whole run ends), exactly like `dispatchRun`. To keep FIFO order it starts at most as many runs as there are free slots, oldest `queuedAt` first; a lost race simply re-queues the run.

- [ ] **Step 1: Write the failing database tests**

Create `src/core/coding-queue.database.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { CODING_QUEUE_TIMEOUT_ERROR, drainCodingQueue } from "./coding-queue.js";

const db = new PrismaClient();
const suffix = randomUUID();
const principalId = `cq-principal-${suffix}`;
const agentId = `cq-agent-${suffix}`;
const ids = {
  active: `cq-active-${suffix}`,
  expired: `cq-expired-${suffix}`,
  oldest: `cq-oldest-${suffix}`,
  newer: `cq-newer-${suffix}`,
};
const all = Object.values(ids);

function recordingExecutor(started: string[]): Executor {
  return {
    async start(runId) {
      started.push(runId);
    },
    async stop() {},
  };
}

async function seed(id: string, opts: { status?: "pending" | "running"; queuedAt?: Date | null; jobBackend?: string }) {
  await db.run.create({ data: { id, agentId, executionManaged: true, status: opts.status ?? "pending" } });
  await db.codingRun.create({
    data: {
      runId: id,
      task: "Fix it.",
      repository: "openai/example",
      baseRef: "main",
      headRef: `wardby/run-${id}`,
      provider: "codex",
      model: "gpt-5.6-luna",
      timeoutSec: 900,
      allowedEgress: [],
      protectedPaths: ["CODEOWNERS"],
      budgetReservedUsd: 1,
      queuedAt: opts.queuedAt ?? null,
      jobBackend: opts.jobBackend ?? null,
      jobHandle: opts.jobBackend ? `handle-${id}` : null,
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)("drainCodingQueue (PostgreSQL)", () => {
  const now = new Date();
  let otherActive = 0;

  beforeAll(async () => {
    otherActive = await db.codingRun.count({
      where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
    });
    await db.principal.create({ data: { id: principalId, subject: principalId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "code safely",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: principalId,
      },
    });
    await seed(ids.active, { status: "running", jobBackend: "docker" });
    await seed(ids.expired, { queuedAt: new Date(now.getTime() - 2 * 3600_000) });
    await seed(ids.oldest, { queuedAt: new Date(now.getTime() - 60_000) });
    await seed(ids.newer, { queuedAt: new Date(now.getTime() - 30_000) });
  });

  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: all } } });
    await db.run.deleteMany({ where: { id: { in: all } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: principalId } });
    await db.$disconnect();
  });

  it("times out stale queued runs and starts the oldest into the free slots only", async () => {
    const started: string[] = [];
    // One of our seeded runs holds a slot; leave room for exactly one more.
    const result = await drainCodingQueue({
      db,
      executor: recordingExecutor(started),
      maxConcurrent: otherActive + 2,
      queueTimeoutSec: 3600,
      now: () => now,
    });

    expect(result.timedOut).toBe(1);
    const expired = await db.run.findUniqueOrThrow({ where: { id: ids.expired } });
    expect(expired.status).toBe("failed");
    expect(expired.error).toBe(CODING_QUEUE_TIMEOUT_ERROR);
    expect((await db.codingRun.findUniqueOrThrow({ where: { runId: ids.expired } })).failureCategory).toBe(
      CODING_QUEUE_TIMEOUT_ERROR,
    );

    expect(started).toEqual([ids.oldest]);
    expect(result.started).toEqual([ids.oldest]);
  });

  it("starts nothing when every slot is taken", async () => {
    const started: string[] = [];
    const result = await drainCodingQueue({
      db,
      executor: recordingExecutor(started),
      maxConcurrent: otherActive + 1,
      queueTimeoutSec: 3600,
      now: () => now,
    });
    expect(started).toEqual([]);
    expect(result.started).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/coding-queue.database.test.ts`
Expected: FAIL (`Failed to load url ./coding-queue.js` / module not found).

- [ ] **Step 3: Implement**

Create `src/core/coding-queue.ts`:

```typescript
/**
 * The coding concurrency queue's driver. claimProvisioning (container.ts)
 * refuses a slot and sets CodingRun.queuedAt when CODING_MAX_CONCURRENT
 * coding runs already hold one; this module later:
 *
 *  1. fails queued runs that waited longer than CODING_QUEUE_TIMEOUT_SEC
 *     (coding_queue_timeout), with a conditional update so concurrent
 *     drains never double-fail a run;
 *  2. starts the oldest queued runs, at most as many as there are free
 *     slots, so order stays FIFO in practice. Starting is fire-and-forget,
 *     like dispatchRun: Executor.start resolves only when the run ends.
 *     A run that loses a slot race is simply re-queued by claimProvisioning.
 *
 * Called on the scheduler leader's tick and immediately in any process
 * whose coding run just finished (ContainerExecutor onSlotReleased).
 */
import type { PrismaClient } from "@prisma/client";
import type { Executor } from "../providers/executor/types.js";
import { markRunFailedFromExecutorError } from "./dispatch.js";
import { logger } from "./logger.js";

const queueLog = logger.child({ module: "coding-queue" });

export const CODING_QUEUE_TIMEOUT_ERROR = "coding_queue_timeout";

export type CodingQueueDb = Pick<PrismaClient, "run" | "codingRun">;

export interface DrainCodingQueueOptions {
  db: CodingQueueDb;
  executor: Executor;
  maxConcurrent: number;
  queueTimeoutSec: number;
  now?: () => Date;
}

export interface DrainCodingQueueResult {
  timedOut: number;
  started: string[];
}

export async function drainCodingQueue(options: DrainCodingQueueOptions): Promise<DrainCodingQueueResult> {
  const { db, executor } = options;
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - options.queueTimeoutSec * 1000);

  let timedOut = 0;
  const expired = await db.codingRun.findMany({
    where: { queuedAt: { lt: cutoff }, run: { status: "pending" } },
    select: { runId: true },
  });
  for (const { runId } of expired) {
    const failed = await db.run.updateMany({
      where: { id: runId, status: "pending" },
      data: { status: "failed", error: CODING_QUEUE_TIMEOUT_ERROR, finishedAt: now },
    });
    if (failed.count === 1) {
      timedOut += 1;
      await db.codingRun.update({ where: { runId }, data: { failureCategory: CODING_QUEUE_TIMEOUT_ERROR } });
    }
  }

  const active = await db.codingRun.count({
    where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
  });
  const free = options.maxConcurrent - active;
  if (free <= 0) return { timedOut, started: [] };

  const next = await db.codingRun.findMany({
    where: { queuedAt: { not: null }, jobBackend: null, run: { status: "pending" } },
    orderBy: { queuedAt: "asc" },
    take: free,
    select: { runId: true },
  });
  for (const { runId } of next) {
    void executor
      .start(runId)
      .catch((err) =>
        markRunFailedFromExecutorError(db, runId, err).catch((err2) =>
          queueLog.error({ err: err2, runId }, "failed to persist queued-run start failure"),
        ),
      );
  }
  return { timedOut, started: next.map((row) => row.runId) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/coding-queue.database.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`

```bash
git add src/core/coding-queue.ts src/core/coding-queue.database.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add drainCodingQueue for queued coding runs

Fails queued coding runs past CODING_QUEUE_TIMEOUT_SEC with
coding_queue_timeout (conditional update, safe under concurrent drains),
then starts the oldest queued runs into however many slots are free, so
order stays FIFO. Starts are fire-and-forget like dispatchRun.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 7: Wire the cap and the drain

**Files:**

- Modify: `src/providers/executor/container.ts` (`ContainerExecutorOptions`, `start`)
- Modify: `src/providers/executor/container.test.ts` (harness gets extra options; new test)
- Modify: `src/providers/executor/composition.ts` (`buildConfiguredExecutor`)
- Modify: `src/core/scheduler.ts` (`SchedulerOptions`, `tick`)
- Modify: `src/serve.ts`, `src/cli.ts` (`scheduler()`)

**Interfaces:**

- Consumes: `loadCodingConcurrencyConfig` (Task 3), `PrismaContainerExecutionStore(db, { maxConcurrent })` (Task 4), `drainCodingQueue` (Task 6).
- Produces: `ContainerExecutorOptions.onSlotReleased?: () => void` (called after a run this process executed reaches a terminal status); `SchedulerOptions.onLeaderTick?: () => Promise<void>` (awaited at the end of each leader tick, errors logged, never thrown).

- [ ] **Step 1: Write the failing unit test for `onSlotReleased`**

In `src/providers/executor/container.test.ts`:

(a) Add `type ContainerExecutorOptions,` to the import from `./container.js`.

(b) Change the `harness` signature's last parameter list from `claude?: { workerImage: string; toolImage: string },` to:

```typescript
  claude?: { workerImage: string; toolImage: string },
  extra: Partial<ContainerExecutorOptions> = {},
```

and add `...extra,` as the last property inside the `new ContainerExecutor({ ... })` object literal.

(c) Add inside `describe("ContainerExecutor", ...)`:

```typescript
it("calls onSlotReleased once after a run reaches a terminal status, never for a queued run", async () => {
  let releases = 0;
  const onSlotReleased = () => {
    releases += 1;
  };
  const finished = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, { onSlotReleased });
  await finished.executor.start("run-1");
  expect(["succeeded", "failed", "budget_exhausted"]).toContain(finished.store.run.status);
  expect(releases).toBe(1);

  releases = 0;
  const queued = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, { onSlotReleased });
  queued.store.slotsFull = true;
  await queued.executor.start("run-1");
  expect(queued.store.run.status).toBe("pending");
  expect(releases).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/executor/container.test.ts -t onSlotReleased`
Expected: FAIL (`expected 0 to be 1`).

- [ ] **Step 3: Implement `onSlotReleased`**

In `src/providers/executor/container.ts`:

(a) Add to `ContainerExecutorOptions`, after `observer?: CodingRunObserver;`:

```typescript
  /**
   * Called after a run this process executed reaches a terminal status,
   * so a waiting run can take the freed concurrency slot right away rather
   * than on the next scheduler tick. Never called for a run that was queued.
   */
  onSlotReleased?: () => void;
```

(b) In `start`, replace:

```typescript
const execution = this.execute(runId).finally(() => this.active.delete(runId));
```

with:

```typescript
const execution = this.execute(runId).finally(async () => {
  this.active.delete(runId);
  if (!this.options.onSlotReleased) return;
  const after = await this.options.store.load(runId).catch(() => null);
  if (after && TERMINAL_STATUSES.has(after.status)) this.options.onSlotReleased();
});
```

- [ ] **Step 4: Run the executor tests**

Run: `npx vitest run src/providers/executor/container.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `onLeaderTick` to the scheduler**

In `src/core/scheduler.ts`, add to `SchedulerOptions` after `onLog?: (message: string) => void;`:

```typescript
  /**
   * Awaited at the end of every tick on the lease holder only; used to drain
   * the coding concurrency queue. Errors are logged, never thrown, so a
   * failing hook cannot stop scheduled agents from firing.
   */
  onLeaderTick?: () => Promise<void>;
```

and at the end of `tick()` (after the `for (const agent of due)` loop closes, still inside `tick`), add:

```typescript
if (options.onLeaderTick) {
  await options.onLeaderTick().catch((err) => schedulerLog.error({ err }, "leader tick hook failed"));
}
```

- [ ] **Step 6: Wire the cap and the release hook in composition**

In `src/providers/executor/composition.ts`:

(a) Add imports:

```typescript
import { loadCodingConcurrencyConfig } from "../../config/providers.js";
import { drainCodingQueue } from "../../core/coding-queue.js";
```

(If `loadProviderConfig` etc. are already imported from `../../config/providers.js`, add `loadCodingConcurrencyConfig` to that import instead.)

(b) Replace the tail of `buildConfiguredExecutor`, from `const coding = new ContainerExecutor({` through `return new RoutingExecutor(...)`, with:

```typescript
const concurrency = loadCodingConcurrencyConfig(env);
// The release hook needs the composed RoutingExecutor, which only exists
// after the ContainerExecutor it wraps is built.
let composed: RoutingExecutor | undefined;
const coding = new ContainerExecutor({
  store: new PrismaContainerExecutionStore(options.db, { maxConcurrent: concurrency.maxConcurrent }),
  jobs,
  vcs,
  sessions,
  capabilities,
  artifactRoot,
  workerImage: config.workerImage,
  claudeWorkerImage: config.claudeWorkerImage,
  claudeToolRunnerImage: config.claudeToolRunnerImage,
  additionalWorkerImages: config.additionalWorkerImages,
  credentialRef: config.credentialRef,
  anthropicCredentialRef: config.anthropicCredentialRef,
  limits: { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids, diskMb: config.diskMb },
  onSlotReleased: () => {
    if (!composed) return;
    void drainCodingQueue({
      db: options.db,
      executor: composed,
      maxConcurrent: concurrency.maxConcurrent,
      queueTimeoutSec: concurrency.queueTimeoutSec,
    }).catch(() => undefined);
  },
});
composed = new RoutingExecutor(new PrismaExecutionKindResolver(options.db), options.native, coding);
return composed;
```

- [ ] **Step 7: Drain on the scheduler leader's tick**

In `src/serve.ts`, add imports:

```typescript
import { loadCodingConcurrencyConfig } from "./config/providers.js";
import { drainCodingQueue } from "./core/coding-queue.js";
import { prisma } from "./core/db.js";
```

(merge with the existing `./config/providers.js` import), and replace:

```typescript
const scheduler = startScheduler({ executor: providers.executor, scope: options.scope });
```

with:

```typescript
const concurrency = loadCodingConcurrencyConfig();
const scheduler = startScheduler({
  executor: providers.executor,
  scope: options.scope,
  onLeaderTick: async () => {
    await drainCodingQueue({ db: prisma, executor: providers.executor, ...concurrency });
  },
});
```

In `src/cli.ts`, in `scheduler()`, replace:

```typescript
const sched = startScheduler({ executor, db: prisma, scope });
```

with:

```typescript
const concurrency = loadCodingConcurrencyConfig();
const sched = startScheduler({
  executor,
  db: prisma,
  scope,
  onLeaderTick: async () => {
    await drainCodingQueue({ db: prisma, executor, ...concurrency });
  },
});
```

and add `loadCodingConcurrencyConfig` to the existing `./config/providers.js` import and `import { drainCodingQueue } from "./core/coding-queue.js";`.

- [ ] **Step 8: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`
Expected: all pass, including `src/serve.test.ts` (its drain runs against an empty queue) and the scheduler tests.

```bash
git add src/providers/executor/container.ts src/providers/executor/container.test.ts src/providers/executor/composition.ts src/core/scheduler.ts src/serve.ts src/cli.ts
git commit -m "$(cat <<'EOF'
feat: enforce the coding concurrency cap and drain the queue

buildConfiguredExecutor now caps claims at CODING_MAX_CONCURRENT (default
4) and drains the queue whenever a run it executed finishes, so a freed
slot is reused within seconds. The scheduler leader also drains on every
tick (serve and scheduler commands), which applies the queue timeout and
picks up slots freed on other replicas. Existing Docker deployments get
the default cap of 4.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 8: Show queued runs in `get_run`, and document the queue

**Files:**

- Modify: `src/mcp/tools/runs.ts` (`get_run` handler, ~line 35)
- Modify: `src/mcp/tools/runs.test.ts` (`FakeRunRow.codingRun` type; new test)
- Modify: `docs/coding-worker-isolation.md` ("Control Plane Configuration" section)

**Interfaces:** `get_run` adds `codingQueuedAt` (ISO string) to its response for a `pending` coding run whose `CodingRun.queuedAt` is set. No other response changes.

- [ ] **Step 1: Write the failing test**

In `src/mcp/tools/runs.test.ts`, change the `codingRun?:` line in `interface FakeRunRow` to:

```typescript
  codingRun?: { result: unknown; jobHandle?: string; protectedPaths?: string[]; queuedAt?: Date | null } | null;
```

and add inside `describe("run observability tools", ...)`:

```typescript
it("get_run marks a coding run waiting for a concurrency slot with codingQueuedAt", async () => {
  const queuedAt = new Date("2026-09-22T12:00:00.000Z");
  const db = fakeDb(
    [{ id: "a1", ownerId: "p1" }],
    [
      {
        id: "r1",
        agentId: "a1",
        status: "pending",
        trigger: "manual",
        turns: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        finalText: null,
        error: null,
        startedAt: queuedAt,
        finishedAt: null,
        codingRun: { result: null, queuedAt },
      },
    ],
  );
  const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
  registerRunTools(mcp);
  const client = await connectClient(mcp);

  const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
  const body = parseText(result as never) as { status: string; codingQueuedAt?: string };
  expect(body.status).toBe("pending");
  expect(body.codingQueuedAt).toBe("2026-09-22T12:00:00.000Z");
  await client.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/mcp/tools/runs.test.ts -t codingQueuedAt`
Expected: FAIL (`expected undefined to be '2026-09-22T12:00:00.000Z'`).

- [ ] **Step 3: Implement**

In `src/mcp/tools/runs.ts`, replace the last three lines of the `get_run` handler:

```typescript
const codingRun = await ctx.db.codingRun.findUnique({ where: { runId: run.id }, select: { result: true } });
const codingResult = publicCodingRunResult(codingRun?.result);
return textResult(codingResult ? { ...run, codingResult } : run);
```

with:

```typescript
const codingRun = await ctx.db.codingRun.findUnique({
  where: { runId: run.id },
  select: { result: true, queuedAt: true },
});
const codingResult = publicCodingRunResult(codingRun?.result);
// A pending coding run with queuedAt is waiting for a concurrency slot
// (CODING_MAX_CONCURRENT), not stuck.
const codingQueuedAt = run.status === "pending" && codingRun?.queuedAt ? codingRun.queuedAt.toISOString() : undefined;
return textResult({
  ...run,
  ...(codingResult ? { codingResult } : {}),
  ...(codingQueuedAt ? { codingQueuedAt } : {}),
});
```

- [ ] **Step 4: Document the queue**

In `docs/coding-worker-isolation.md`, in the "Control Plane Configuration" section, after the paragraph that begins "Set `JOB_LAUNCHER=docker`", add:

```markdown
`CODING_MAX_CONCURRENT` (default `4`) caps coding runs that hold a slot at
once, across every control-plane replica: the cap is enforced in Postgres
inside the provisioning claim, so adding replicas never raises it. A run
over the cap stays `pending` and `get_run` shows `codingQueuedAt`; it starts,
oldest first, when a slot frees (immediately in the process whose run
finished, or on the scheduler leader's next tick). A run still queued after
`CODING_QUEUE_TIMEOUT_SEC` (default `3600`) fails with `coding_queue_timeout`.
Slot usage is derived from run state, so a crashed replica cannot leak slots:
its runs are reconciled to `lost`, which frees them. Clones are shallow
(`--depth 1`); the worker never receives Git history and finalization needs
only the base commit.
```

- [ ] **Step 5: Run to verify pass, full checks, commit**

Run: `npx vitest run src/mcp/tools/runs.test.ts` then `npm run typecheck && npm run lint && npm test && npm run format:check`
Expected: all pass.

```bash
git add src/mcp/tools/runs.ts src/mcp/tools/runs.test.ts docs/coding-worker-isolation.md
git commit -m "$(cat <<'EOF'
feat(mcp): show queued coding runs in get_run; document the queue

get_run adds codingQueuedAt for a pending coding run waiting for a
concurrency slot, so it doesn't look stuck. docs/coding-worker-isolation.md
documents CODING_MAX_CONCURRENT, CODING_QUEUE_TIMEOUT_SEC, cross-replica
enforcement, and shallow clones.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Self-review notes

- **Spec coverage (§4, §6):** shallow clone → Task 1 (plus real-git proof resolving spec open item 6). Cap across replicas via Postgres → Task 4. Slot usage derived from run state → Task 4 (existing `jobBackend` + run status; spec's "slot claimed at" column proved unnecessary, so only `queuedAt` is added — Task 2). Queue with FIFO, timeout, fixed reason → Task 6. Drain on leader tick + immediate on finish → Task 7. Reconciler must not reap queued runs (found during planning; not in the spec) → Task 5. Budget check before queueing: already satisfied — the budget is reserved at dispatch time (`dispatchRun`, `budgetReservedUsd`) before any claim, and the proxy session enforces it at run time; no re-check code is added. Visibility → Task 8. Docs → Tasks 3 and 8.
- **Deferred to Plan 2 (stated in the header):** per-agent workspace size; everything Kubernetes. **Plan 3:** GKE, logs, acceptance.
- **Type names used consistently:** `ProvisioningClaim`, `PrismaContainerExecutionStore(db, { maxConcurrent })`, `CodingConcurrencyConfig` / `loadCodingConcurrencyConfig`, `drainCodingQueue` / `DrainCodingQueueOptions` / `DrainCodingQueueResult` / `CODING_QUEUE_TIMEOUT_ERROR`, `onSlotReleased`, `onLeaderTick`.
- **Known test risk:** the cap is global by design, so the database tests in Tasks 4 and 6 measure other active coding runs first and assert relative counts. Vitest runs files in parallel; if another file seeds an active coding run mid-test, these can flake. If that happens, move the Task 4 cap test and the Task 6 drain tests into one file (tests within a file run sequentially) rather than loosening the assertions.
