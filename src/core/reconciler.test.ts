import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { PrismaExecutionKindResolver, RoutingExecutor } from "../providers/executor/routing.js";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import type { IssueTracker } from "../providers/issue-tracker/types.js";

vi.mock("./pull-request-state-sync.js", () => ({ syncOpenPullRequestStates: vi.fn(async () => 0) }));
import { syncOpenPullRequestStates } from "./pull-request-state-sync.js";
vi.mock("./merge-order-check.js", () => ({ sweepMergeOrderChecks: vi.fn(async () => 0) }));
import { sweepMergeOrderChecks } from "./merge-order-check.js";
vi.mock("./host-events.js", () => ({ startDeferredReviews: vi.fn(async () => []) }));
import { startDeferredReviews, type ReviewStartDeps } from "./host-events.js";
import { reconcileOnce, type ReconcilerDb } from "./reconciler.js";
import { setWorkflowEventSink, type WorkflowEventInput } from "./workflow-events.js";

interface FakeRun {
  id: string;
  status: string;
  trigger: string;
  heartbeatAt: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  executionManaged: boolean;
  executionBackend: string | null;
  agent: { kind: "native" | "coding" };
  codingRun: { jobBackend: string | null; jobHandle: string | null } | null;
}

/** Minimal Prisma-`where`-filter matcher: equality, `{lt}`, `null`, and nested `OR` arrays. */
function matches(run: FakeRun, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = cond as Record<string, unknown>[];
      if (!clauses.some((clause) => matches(run, clause))) return false;
      continue;
    }
    const value = (run as unknown as Record<string, unknown>)[key];
    if (cond === null) {
      if (value !== null) return false;
    } else if (typeof cond === "object" && cond !== null) {
      if ("lt" in cond) {
        const lt = (cond as { lt: Date }).lt;
        if (!(value instanceof Date) || !(value < lt)) return false;
      } else if ("in" in cond) {
        if (!(cond as { in: unknown[] }).in.includes(value)) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function fakeDb(runs: FakeRun[]): ReconcilerDb {
  const byId = new Map(runs.map((r) => [r.id, r]));

  return {
    run: {
      findMany: (async ({ where }: any) => [...byId.values()].filter((run) => matches(run, where))) as any,
      updateMany: (async ({ where, data }: any) => {
        let count = 0;
        for (const run of byId.values()) {
          if (!matches(run, where)) continue;
          Object.assign(run, data);
          count += 1;
        }
        return { count };
      }) as any,
    },
  } as unknown as ReconcilerDb;
}

const HEARTBEAT_TIMEOUT_MS = 45_000;
const NOW = new Date("2026-09-05T12:00:00.000Z");
const STALE = new Date(NOW.getTime() - HEARTBEAT_TIMEOUT_MS - 1_000);
const FRESH = new Date(NOW.getTime() - 5_000);

function baseRun(overrides: Partial<FakeRun>): FakeRun {
  return {
    id: "r1",
    status: "running",
    trigger: "scheduled",
    heartbeatAt: FRESH,
    startedAt: new Date(NOW.getTime() - 60_000),
    finishedAt: null,
    error: null,
    executionManaged: true,
    executionBackend: null,
    agent: { kind: "native" },
    codingRun: null,
    ...overrides,
  };
}

describe("reconcileOnce", () => {
  it("marks a scheduled run with a stale heartbeat as lost", async () => {
    const runs = [baseRun({ heartbeatAt: STALE })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
    expect(runs[0].error).toMatch(/Orphaned/);
    expect(runs[0].finishedAt).toEqual(NOW);
  });

  it("leaves a scheduled run with a fresh heartbeat alone", async () => {
    const runs = [baseRun({ heartbeatAt: FRESH })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("running");
  });

  it("recovers a scheduled run that never got a first heartbeat, once older than the timeout", async () => {
    const runs = [baseRun({ heartbeatAt: null, startedAt: STALE })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
  });

  it("recovers a scheduled run stuck pending past the timeout (crash before it ever started)", async () => {
    const runs = [baseRun({ status: "pending", heartbeatAt: null, startedAt: STALE })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
  });

  it("leaves a scheduled run pending for less than the timeout alone", async () => {
    const runs = [baseRun({ status: "pending", heartbeatAt: null, startedAt: FRESH })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("pending");
  });

  it("never reaps an attended unmanaged run, even with no heartbeat and an old startedAt", async () => {
    // This is the bug this scoping fixes: an attended `wardby run` has no
    // heartbeat by design, so without the trigger scope a long-streaming
    // manual run would get flipped to `lost` while a human still watches it.
    const runs = [baseRun({ trigger: "manual", executionManaged: false, heartbeatAt: null, startedAt: STALE })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("running");
  });

  it("ignores non-running, non-pending runs regardless of heartbeat age", async () => {
    const runs = [baseRun({ status: "succeeded", heartbeatAt: STALE, finishedAt: NOW })];
    const db = fakeDb(runs);

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("succeeded");
  });

  it("is a no-op the second time (double-reconcile is idempotent)", async () => {
    const runs = [baseRun({ heartbeatAt: STALE })];
    const db = fakeDb(runs);

    const first = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);
    const second = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("does not overwrite a heartbeat that becomes fresh after candidate selection", async () => {
    const runs = [baseRun({ heartbeatAt: STALE })];
    const db = fakeDb(runs);
    const updateMany = db.run.updateMany.bind(db.run);
    db.run.updateMany = (async (args: any) => {
      runs[0].heartbeatAt = FRESH;
      return updateMany(args);
    }) as typeof db.run.updateMany;

    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("running");
  });

  it("recovers a detached manual run because management is explicit rather than inferred from trigger", async () => {
    const runs = [baseRun({ trigger: "manual", heartbeatAt: STALE })];
    const count = await reconcileOnce(fakeDb(runs), NOW, HEARTBEAT_TIMEOUT_MS);
    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
  });

  it("does not relaunch a stale coding run whose handle was never persisted", async () => {
    const runs = [
      baseRun({
        status: "pending",
        heartbeatAt: null,
        startedAt: STALE,
        agent: { kind: "coding" },
      }),
    ];
    const start = async () => {
      throw new Error("must not relaunch");
    };
    const executor = { start, async stop() {} } satisfies Executor;

    const count = await reconcileOnce(fakeDb(runs), NOW, HEARTBEAT_TIMEOUT_MS, executor);

    expect(count).toBe(1);
    expect(runs[0].status).toBe("lost");
    expect(runs[0].error).toMatch(/not relaunched/i);
  });

  it("passes the persisted handle to recovery and refreshes a confirmed active job", async () => {
    const runs = [
      baseRun({
        heartbeatAt: STALE,
        agent: { kind: "coding" },
        codingRun: { jobBackend: "docker", jobHandle: "container-1" },
      }),
    ];
    const seen: unknown[] = [];
    const executor: Executor = {
      async start() {},
      async stop() {},
      async recover(handle) {
        seen.push(handle);
        return { state: "active" };
      },
    };

    const count = await reconcileOnce(fakeDb(runs), NOW, HEARTBEAT_TIMEOUT_MS, executor);

    expect(count).toBe(0);
    expect(seen).toEqual([{ runId: "r1", backend: "docker", id: "container-1" }]);
    expect(runs[0].heartbeatAt).toEqual(NOW);
  });

  it("marks a handled coding job lost only after recovery reports stop and collection complete", async () => {
    const runs = [
      baseRun({
        heartbeatAt: STALE,
        agent: { kind: "coding" },
        codingRun: { jobBackend: "docker", jobHandle: "container-1" },
      }),
    ];
    const executor: Executor = {
      async start() {},
      async stop() {},
      async recover() {
        return { state: "lost", reason: "container disappeared after collection" };
      },
    };

    const count = await reconcileOnce(fakeDb(runs), NOW, HEARTBEAT_TIMEOUT_MS, executor);

    expect(count).toBe(1);
    expect(runs[0].error).toBe("container disappeared after collection");
  });

  it("leaves the run recoverable when collection fails, so a later pass can retry", async () => {
    const runs = [
      baseRun({
        heartbeatAt: STALE,
        agent: { kind: "coding" },
        codingRun: { jobBackend: "docker", jobHandle: "container-1" },
      }),
    ];
    const executor: Executor = {
      async start() {},
      async stop() {},
      async recover() {
        throw new Error("artifact temporarily unavailable");
      },
    };

    const count = await reconcileOnce(fakeDb(runs), NOW, HEARTBEAT_TIMEOUT_MS, executor);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("running");
  });

  it("does not overwrite a terminal result recovered after PR creation", async () => {
    const runs = [
      baseRun({
        heartbeatAt: STALE,
        agent: { kind: "coding" },
        codingRun: { jobBackend: "docker", jobHandle: "container-1" },
      }),
    ];
    const executor: Executor = {
      async start() {},
      async stop() {},
      async recover() {
        runs[0].status = "succeeded";
        return { state: "terminal" };
      },
    };

    const count = await reconcileOnce(fakeDb(runs), NOW, HEARTBEAT_TIMEOUT_MS, executor);

    expect(count).toBe(0);
    expect(runs[0].status).toBe("succeeded");
  });

  it("consults the executor before reaping a stale run held by a durable backend, and keeps it alive when active", async () => {
    const runs = [baseRun({ heartbeatAt: STALE, executionBackend: "dbos" })];
    const db = fakeDb(runs);
    const recover = vi.fn(async () => ({ state: "active" as const }));
    const executor: Executor = { start: async () => undefined, stop: async () => undefined, recover };

    const lost = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, executor);

    expect(lost).toBe(0);
    expect(recover).toHaveBeenCalledWith({ runId: runs[0].id, backend: "dbos", id: runs[0].id });
    expect(runs[0].status).toBe("running");
    expect(runs[0].heartbeatAt).toEqual(NOW);
  });

  it("marks a durable-backend run lost when the executor reports it lost", async () => {
    const runs = [baseRun({ heartbeatAt: STALE, executionBackend: "dbos" })];
    const db = fakeDb(runs);
    const executor: Executor = {
      start: async () => undefined,
      stop: async () => undefined,
      recover: async () => ({ state: "lost", reason: "gone" }),
    };

    const lost = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, executor);

    expect(lost).toBe(1);
    expect(runs[0].status).toBe("lost");
    expect(runs[0].error).toBe("gone");
  });

  it("leaves a durable-backend run alone when the executor reports terminal", async () => {
    const runs = [baseRun({ heartbeatAt: STALE, executionBackend: "dbos" })];
    const db = fakeDb(runs);
    const executor: Executor = {
      start: async () => undefined,
      stop: async () => undefined,
      recover: async () => ({ state: "terminal" }),
    };

    expect(await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, executor)).toBe(0);
    expect(runs[0].status).toBe("running"); // the executor's recover() owns the terminal write
  });

  it("sends a stale sandbox-mode run's handle to the sandbox executor, never to the DBOS-owning native one", async () => {
    const runs = [baseRun({ heartbeatAt: STALE, executionBackend: "native-sandbox" })];
    const db = fakeDb(runs);
    const resolver = new PrismaExecutionKindResolver({
      run: { findUnique: async () => ({ nativeExecutionMode: "sandbox", agent: { kind: "native" } }) },
    });
    const nativeRecover = vi.fn(async () => ({
      state: "lost" as const,
      reason: 'DbosExecutor cannot recover backend "native-sandbox".',
    }));
    const sandboxRecover = vi.fn(async () => ({ state: "lost" as const, reason: "worker container is gone" }));
    const executor = new RoutingExecutor(
      resolver,
      { start: async () => undefined, stop: async () => undefined, recover: nativeRecover },
      { start: async () => undefined, stop: async () => undefined },
      { start: async () => undefined, stop: async () => undefined, recover: sandboxRecover },
    );

    expect(await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, executor)).toBe(1);
    expect(sandboxRecover).toHaveBeenCalledWith({ runId: "r1", backend: "native-sandbox", id: "r1" });
    expect(nativeRecover).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ status: "lost", error: "worker container is gone" });
  });

  it("falls back to the plain lost path for a durable-backend run when no executor can recover", async () => {
    const runs = [baseRun({ heartbeatAt: STALE, executionBackend: "dbos" })];
    const db = fakeDb(runs);

    expect(await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined)).toBe(1);
    expect(runs[0].status).toBe("lost");
  });
});

interface FakeHostCheck {
  runId: string;
  provider: string;
  repository: string;
  checkId: string;
  headSha: string;
  completedAt: Date | null;
}

/** A fake `runHostCheck` delegate that honours the orphan query's filters (provider, completedAt, run status/finishedAt, take). */
function withHostChecks(db: ReconcilerDb, runs: FakeRun[], checks: FakeHostCheck[]) {
  const findMany = vi.fn(async ({ where, take }: any) => {
    const out = checks
      .filter((check) => {
        const run = runs.find((r) => r.id === check.runId);
        if (!run || check.completedAt !== where.completedAt) return false;
        if (!where.provider.in.includes(check.provider)) return false;
        if (where.run.status.notIn.includes(run.status)) return false;
        const { lte, gte } = where.run.finishedAt;
        return run.finishedAt !== null && run.finishedAt <= lte && run.finishedAt >= gte;
      })
      .map((check) => ({ run: runs.find((r) => r.id === check.runId)! }));
    return out.slice(0, take);
  });
  const runHostCheck = {
    findMany,
    findUnique: vi.fn(async ({ where }: any) => checks.find((c) => c.runId === where.runId) ?? null),
    update: vi.fn(async ({ where, data }: any) =>
      Object.assign(
        checks.find((c) => c.runId === where.runId)!,
        data,
      ),
    ),
  };
  const runHostStatus = { findMany: vi.fn(async () => []) };
  return { db: { ...db, runHostCheck, runHostStatus } as unknown as ReconcilerDb, runHostCheck };
}

function hostCheck(runId: string): FakeHostCheck {
  return { runId, provider: "github", repository: "o/n", checkId: `c-${runId}`, headSha: "a", completedAt: null };
}

const fakeHost = () =>
  ({ provider: "github", completeCheck: vi.fn(async () => undefined) }) as unknown as CodeReviewHost;

describe("reconcileOnce orphaned host checks", () => {
  const LONG_DONE = new Date(NOW.getTime() - 61_000);
  const JUST_DONE = new Date(NOW.getTime() - 30_000);

  it("completes an open check whose run ended long enough ago, whatever the terminal status", async () => {
    const runs = [
      baseRun({ id: "lost1", status: "lost", finishedAt: LONG_DONE }),
      baseRun({ id: "failed1", status: "failed", finishedAt: LONG_DONE }),
      baseRun({ id: "refused1", status: "refused", finishedAt: LONG_DONE }),
    ];
    const checks = [hostCheck("lost1"), hostCheck("failed1"), hostCheck("refused1")];
    const { db } = withHostChecks(fakeDb(runs), runs, checks);
    const host = fakeHost();

    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, { github: host });

    expect(host.completeCheck).toHaveBeenCalledTimes(3);
    expect(host.completeCheck).toHaveBeenCalledWith(
      "o/n",
      expect.objectContaining({ checkId: "c-lost1", conclusion: "failure", title: "Review did not complete" }),
    );
    expect(host.completeCheck).toHaveBeenCalledWith(
      "o/n",
      expect.objectContaining({
        checkId: "c-refused1",
        conclusion: "failure",
        title: "Review could not run: out of budget",
      }),
    );
    expect(checks.every((c) => c.completedAt !== null)).toBe(true);
  });

  it("leaves checks of live runs, recently finished runs, and already-completed checks alone", async () => {
    const runs = [
      baseRun({ id: "live", status: "running", heartbeatAt: FRESH }),
      baseRun({ id: "recent", status: "succeeded", finishedAt: JUST_DONE }),
      baseRun({ id: "done", status: "succeeded", finishedAt: LONG_DONE }),
    ];
    const checks = [hostCheck("live"), hostCheck("recent"), { ...hostCheck("done"), completedAt: LONG_DONE }];
    const { db } = withHostChecks(fakeDb(runs), runs, checks);
    const host = fakeHost();

    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, { github: host });

    expect(host.completeCheck).not.toHaveBeenCalled();
  });

  it("closes the check of a run it marks lost only on a later pass, once the grace period has passed", async () => {
    const runs = [baseRun({ id: "stale", heartbeatAt: STALE })];
    const checks = [hostCheck("stale")];
    const { db } = withHostChecks(fakeDb(runs), runs, checks);
    const host = fakeHost();

    expect(await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, { github: host })).toBe(1);
    expect(host.completeCheck).not.toHaveBeenCalled();

    await reconcileOnce(db, new Date(NOW.getTime() + 60_000), HEARTBEAT_TIMEOUT_MS, undefined, { github: host });
    expect(host.completeCheck).toHaveBeenCalledTimes(1);
    expect(checks[0].completedAt).not.toBeNull();
  });

  it("caps each pass at 50 checks, newest-finished first", async () => {
    const runs = Array.from({ length: 60 }, (_, i) =>
      baseRun({ id: `r${i}`, status: "failed", finishedAt: LONG_DONE }),
    );
    const { db, runHostCheck } = withHostChecks(
      fakeDb(runs),
      runs,
      runs.map((r) => hostCheck(r.id)),
    );
    const host = fakeHost();

    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, { github: host });

    expect(runHostCheck.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, orderBy: { run: { finishedAt: "desc" } } }),
    );
    expect(host.completeCheck).toHaveBeenCalledTimes(50);
  });

  it("gives up on a check whose run finished more than a day ago", async () => {
    const runs = [baseRun({ id: "old", status: "lost", finishedAt: new Date(NOW.getTime() - 24 * 60 * 60_000 - 1) })];
    const checks = [hostCheck("old")];
    const { db } = withHostChecks(fakeDb(runs), runs, checks);
    const host = fakeHost();

    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, { github: host });

    expect(host.completeCheck).not.toHaveBeenCalled();
    expect(checks[0].completedAt).toBeNull();
  });

  it("never queries host checks when no review host is configured", async () => {
    const runs = [baseRun({ id: "lost1", status: "lost", finishedAt: LONG_DONE })];
    const { db, runHostCheck } = withHostChecks(fakeDb(runs), runs, [hostCheck("lost1")]);

    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, {});
    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, undefined);

    expect(runHostCheck.findMany).not.toHaveBeenCalled();
    expect(runHostCheck.findUnique).not.toHaveBeenCalled();
  });
});

describe("reconcileOnce orphaned status comments", () => {
  const LONG_DONE = new Date(NOW.getTime() - 61_000);

  function withStatuses(
    runs: FakeRun[],
    statuses: Array<{ runId: string; completedAt: Date | null; commentId?: string | null }>,
  ) {
    const base = fakeDb(runs) as unknown as { run: Record<string, unknown> };
    const rows = statuses.map((s) => ({
      ...s,
      provider: "github",
      repository: "o/n",
      number: 3,
      commentKind: "conversation",
      replyToReviewCommentId: null,
      commentId: s.commentId === undefined ? `c-${s.runId}` : s.commentId,
    }));
    const runHostStatus = {
      findMany: vi.fn(async ({ where, take }: any) =>
        rows
          .filter((row) => {
            const run = runs.find((r) => r.id === row.runId);
            if (!run || row.completedAt !== where.completedAt) return false;
            if (!where.provider.in.includes(row.provider)) return false;
            if (where.run.status.notIn.includes(run.status)) return false;
            const { lte, gte } = where.run.finishedAt;
            return run.finishedAt !== null && run.finishedAt <= lte && run.finishedAt >= gte;
          })
          .map((row) => ({ run: { ...runs.find((r) => r.id === row.runId)!, finalText: null } }))
          .slice(0, take),
      ),
      findUnique: vi.fn(async ({ where }: any) => rows.find((r) => r.runId === where.runId) ?? null),
      update: vi.fn(async ({ where, data }: any) =>
        Object.assign(
          rows.find((r) => r.runId === where.runId)!,
          data,
        ),
      ),
    };
    const runHostCheck = { findMany: vi.fn(async () => []) };
    const run = {
      ...base.run,
      findMany: vi.fn(async (args: any) =>
        args.where.parentRunId ? [] : (base.run.findMany as (a: unknown) => unknown)(args),
      ),
    };
    return { db: { run, runHostCheck, runHostStatus } as unknown as ReconcilerDb, rows };
  }

  it("edits the status comment of a run that ended without completing it", async () => {
    const runs = [
      baseRun({ id: "lost1", status: "lost", finishedAt: LONG_DONE }),
      baseRun({ id: "live", status: "running", heartbeatAt: FRESH }),
    ];
    const { db, rows } = withStatuses(runs, [
      { runId: "lost1", completedAt: null },
      { runId: "live", completedAt: null },
    ]);
    const host = { provider: "github", editComment: vi.fn(async () => undefined) } as unknown as CodeReviewHost;

    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, { github: host });

    expect(host.editComment).toHaveBeenCalledTimes(1);
    expect(host.editComment).toHaveBeenCalledWith("o/n", {
      kind: "conversation",
      id: "c-lost1",
      body: expect.stringMatching(/^❌ Interrupted before it finished/),
    });
    expect(rows.find((r) => r.runId === "lost1")!.completedAt).not.toBeNull();
    expect(rows.find((r) => r.runId === "live")!.completedAt).toBeNull();
  });
  it("posts the outcome as a new comment when the run died before its comment was posted", async () => {
    const runs = [baseRun({ id: "died", status: "lost", finishedAt: LONG_DONE })];
    const { db, rows } = withStatuses(runs, [{ runId: "died", completedAt: null, commentId: null }]);
    const host = {
      provider: "github",
      editComment: vi.fn(async () => undefined),
      comment: vi.fn(async () => ({ url: "https://x/9", id: "9" })),
    } as unknown as CodeReviewHost;

    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, { github: host });

    expect(host.editComment).not.toHaveBeenCalled();
    expect(host.comment).toHaveBeenCalledWith("o/n", {
      number: 3,
      body: expect.stringMatching(/^❌ Interrupted before it finished/),
    });
    expect(rows[0]).toMatchObject({ commentId: "9", completedAt: expect.any(Date) });
  });
});

describe("reconcileOnce orphaned issue status comments", () => {
  it("completes the Jira status comment of a run that ended without completing it", async () => {
    const row = {
      runId: "lost1",
      provider: "jira",
      issueKey: "PROJ-1",
      commentId: "900",
      visibilityRole: null,
      completedAt: null as Date | null,
    };
    const runIssueStatus = {
      findMany: vi.fn(async () => [{ run: { id: "lost1", status: "lost", finalText: null } }]),
      findUnique: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: any) => Object.assign(row, data)),
    };
    // No stale runs to reap; collectRunOutcome's child-run query finds none either.
    const run = {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ agentId: "a1" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const agentIssueProject = { findUnique: vi.fn(async () => ({ access: "write", commentVisibilityRole: null })) };
    const db = {
      run,
      runIssueStatus,
      agentIssueProject,
      $queryRaw: async () => [{ usd: null }],
    } as unknown as ReconcilerDb;
    const tracker = { provider: "jira", editComment: vi.fn(async () => undefined) } as unknown as IssueTracker;

    await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, undefined, { jira: tracker });

    expect(tracker.editComment).toHaveBeenCalledWith("PROJ-1", "900", {
      markdown: expect.stringMatching(/^❌ Interrupted before it finished/),
      issueKeyProjects: ["PROJ"],
    });
    expect(row.completedAt).toBeInstanceOf(Date);
  });
});

describe("reconcileOnce self-defects", () => {
  function selfDefectDb(runs: FakeRun[], opts: { optedIn: boolean }) {
    const created: any[] = [];
    const db = fakeDb(runs) as any;
    db.agent = {
      findUnique: vi.fn(async () => ({
        id: "a1",
        name: "nightly",
        defectProjectKey: opts.optedIn ? "OPS" : null,
        defectIssueType: opts.optedIn ? "Bug" : null,
      })),
    };
    db.agentIssueProject = {
      findUnique: vi.fn(async () => ({
        provider: "jira",
        projectKey: "OPS",
        access: "write",
        commentVisibilityRole: null,
        creatableIssueTypes: ["Bug"],
      })),
    };
    db.codingRun = { findUnique: vi.fn(async () => null) };
    db.runIssueStatus = { findMany: vi.fn(async () => []) };
    db.$transaction = async (fn: any) =>
      fn({
        $executeRaw: async () => 0,
        issueFingerprint: {
          findFirst: async () => null,
          create: async ({ data }: any) => (created.push(data), data),
        },
      });
    return { db: db as ReconcilerDb, created };
  }

  function jira(): IssueTracker {
    return {
      provider: "jira",
      createIssue: vi.fn(async () => ({ id: "1", key: "OPS-7", url: "https://your-site.atlassian.net/browse/OPS-7" })),
    } as unknown as IssueTracker;
  }

  it("files a defect for a run it marks lost, fingerprinted without the reason text", async () => {
    const runs = [{ ...baseRun({ heartbeatAt: STALE }), agentId: "a1" } as FakeRun];
    const { db, created } = selfDefectDb(runs, { optedIn: true });
    const tracker = jira();
    const count = await reconcileOnce(db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, undefined, { jira: tracker });
    expect(count).toBe(1);
    expect(tracker.createIssue).toHaveBeenCalledTimes(1);
    const input = vi.mocked(tracker.createIssue).mock.calls[0][0];
    expect(input).toMatchObject({
      projectKey: "OPS",
      issueType: "Bug",
      summary: 'wardby agent "nightly": lost (orphaned)',
    });
    expect(input.descriptionMarkdown).not.toContain("heartbeat");
    expect(created).toEqual([expect.objectContaining({ issueKey: "OPS-7", createdByRunId: "r1" })]);
  });

  it("files nothing for an agent that has not opted in, or when the run was not stale", async () => {
    const tracker = jira();
    const optedOut = selfDefectDb([baseRun({ heartbeatAt: STALE })], { optedIn: false });
    await reconcileOnce(optedOut.db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, undefined, { jira: tracker });
    const fresh = selfDefectDb([baseRun({ heartbeatAt: FRESH })], { optedIn: true });
    await reconcileOnce(fresh.db, NOW, HEARTBEAT_TIMEOUT_MS, undefined, undefined, { jira: tracker });
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect((fresh.db as any).agent.findUnique).not.toHaveBeenCalled();
  });
});

describe("reconcileOnce workflow events", () => {
  it("emits run_failed with status lost for a stale top-level run it marks lost", async () => {
    const runs = [{ ...baseRun({ heartbeatAt: STALE }), agentId: "a1", parentRunId: null } as FakeRun];
    const db = fakeDb(runs) as any;
    db.agent = { findUnique: vi.fn(async () => ({ name: "nightly", defectProjectKey: null })) };
    db.runHostCheck = { findUnique: vi.fn(async () => null) };
    const events: WorkflowEventInput[] = [];
    setWorkflowEventSink(async (e) => {
      events.push(e);
    });
    try {
      expect(await reconcileOnce(db as ReconcilerDb, NOW, HEARTBEAT_TIMEOUT_MS)).toBe(1);
      expect(events).toEqual([
        {
          dedupeKey: "run_failed:r1",
          runId: "r1",
          agentId: "a1",
          payload: {
            kind: "run_failed",
            agentName: "nightly",
            status: "lost",
            reason: expect.stringContaining("Orphaned"),
          },
        },
      ]);
      // A second pass finds nothing stale and emits nothing more.
      await reconcileOnce(db as ReconcilerDb, NOW, HEARTBEAT_TIMEOUT_MS);
      expect(events).toHaveLength(1);
    } finally {
      setWorkflowEventSink(null);
    }
  });
});

describe("reconcileOnce pull-request state sync", () => {
  it("syncs stored pull-request states once per pass", async () => {
    vi.mocked(syncOpenPullRequestStates).mockClear();
    const hosts = { github: {} } as never;
    const trackers = { jira: {} } as never;
    const now = new Date("2026-10-05T12:00:00Z");
    // Hosts/trackers given, so the existing orphan sweeps also run; the fixture has no such tables.
    const db = {
      ...fakeDb([]),
      runHostCheck: { findMany: vi.fn(async () => []) },
      runHostStatus: { findMany: vi.fn(async () => []) },
      runIssueStatus: { findMany: vi.fn(async () => []) },
    } as unknown as ReconcilerDb;

    await reconcileOnce(db, now, undefined, undefined, hosts, trackers);

    expect(syncOpenPullRequestStates).toHaveBeenCalledWith(expect.anything(), hosts, trackers, now);
  });

  it("sweeps the merge order checks after the pull-request states and the deferred-review start, with the pass's hosts and clock", async () => {
    const order: string[] = [];
    vi.mocked(syncOpenPullRequestStates).mockImplementationOnce(async () => (order.push("states"), 0));
    vi.mocked(startDeferredReviews).mockImplementationOnce(async () => (order.push("deferred"), []));
    vi.mocked(sweepMergeOrderChecks).mockClear();
    vi.mocked(sweepMergeOrderChecks).mockImplementationOnce(async () => (order.push("merge-order"), 0));
    const hosts = { github: {} } as never;
    const now = new Date("2026-10-05T12:00:00Z");
    const db = {
      ...fakeDb([]),
      runHostCheck: { findMany: vi.fn(async () => []) },
      runHostStatus: { findMany: vi.fn(async () => []) },
    } as unknown as ReconcilerDb;

    await reconcileOnce(db, now, undefined, undefined, hosts, undefined, {} as ReviewStartDeps);

    expect(sweepMergeOrderChecks).toHaveBeenCalledWith({ db, hosts }, now);
    expect(order).toEqual(["states", "deferred", "merge-order"]);
  });
});

describe("reconcileOnce deferred reviews", () => {
  it("runs the deferred-review sweep with the pass's clock when host-event deps are given", async () => {
    vi.mocked(startDeferredReviews).mockClear();
    const deferred = { hosts: {} } as unknown as ReviewStartDeps;
    await reconcileOnce(fakeDb([]), NOW, HEARTBEAT_TIMEOUT_MS, undefined, undefined, undefined, deferred);
    expect(startDeferredReviews).toHaveBeenCalledWith(deferred, NOW);
  });

  it("skips the sweep without host-event deps", async () => {
    vi.mocked(startDeferredReviews).mockClear();
    await reconcileOnce(fakeDb([]), NOW, HEARTBEAT_TIMEOUT_MS);
    expect(startDeferredReviews).not.toHaveBeenCalled();
  });
});
