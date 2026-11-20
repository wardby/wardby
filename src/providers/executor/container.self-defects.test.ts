import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import type { IssueTracker } from "../issue-tracker/types.js";
import { buildRunFollowUpHandlers } from "../../core/run-follow-up-handlers.js";
import { CODING_FOLLOW_UP_GRACE_MS, CODING_FOLLOW_UP_KINDS } from "./container-follow-ups.js";
import { PrismaContainerExecutionStore } from "./container.js";

// The container store ends coding runs itself (terminate / complete). In the same transaction it queues
// the run's chores; a run it makes failed, lost or budget_exhausted gets a self_defect chore, which the
// scheduler leader's drain runs (the shared handler) to file a self-defect for an opted-in agent.

function harness(initialStatus: string) {
  const row = {
    id: "run1",
    agentId: "a1",
    status: initialStatus,
    error: null as string | null,
    codingRun: { runId: "run1", result: null as unknown, failureCategory: null as string | null },
  };
  const created: any[] = [];
  const queued: { runId: string; kind: string; nextAttemptAt?: Date }[] = [];
  const db: any = {
    runFollowUp: {
      createMany: vi.fn(async ({ data }: any) => {
        queued.push(...data);
        return { count: data.length };
      }),
    },
    run: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!where.status.in.includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => Object.assign(row, data)),
      findUnique: vi.fn(async () => row),
    },
    codingRun: {
      update: vi.fn(async ({ data }: any) => Object.assign(row.codingRun, data)),
      findUnique: vi.fn(async () => ({ failureCategory: row.codingRun.failureCategory })),
    },
    agent: {
      findUnique: vi.fn(async () => ({ id: "a1", name: "coder", defectProjectKey: "OPS", defectIssueType: "Bug" })),
    },
    agentIssueProject: {
      findUnique: vi.fn(async () => ({
        provider: "jira",
        projectKey: "OPS",
        access: "write",
        commentVisibilityRole: null,
        creatableIssueTypes: ["Bug"],
      })),
    },
    $executeRaw: async () => 0,
    issueFingerprint: {
      findFirst: async () => null,
      create: async ({ data }: any) => (created.push(data), data),
    },
  };
  db.$transaction = async (fn: any) => fn(db);
  // complete() locks the run's row first; nothing to lock in this fake.
  db.$queryRaw = vi.fn(async () => []);
  const tracker = {
    provider: "jira",
    createIssue: vi.fn(async () => ({ id: "1", key: "OPS-3", url: "https://your-site.atlassian.net/browse/OPS-3" })),
  } as unknown as IssueTracker;
  const store = new PrismaContainerExecutionStore(db as PrismaClient, { issueTrackers: { jira: tracker } });
  // What the drain does with the queued self-defect chores.
  const drain = async () => {
    const handlers = buildRunFollowUpHandlers({ db, issueTrackers: { jira: tracker } });
    for (const { runId, kind } of queued.filter((row) => row.kind === "self_defect")) {
      await handlers[kind]({ runId, kind, payload: {}, attempt: 1, signal: new AbortController().signal });
    }
  };
  return { store, tracker, row, created, queued, drain };
}

const RESULT = { summary: "done" } as any;

describe("PrismaContainerExecutionStore self-defects", () => {
  it("files when terminate fails a coding run, using its failure category and no error text", async () => {
    const { store, tracker, created, drain } = harness("running");
    await store.terminate("run1", "failed", "coding_failure_git:diag-1 token ghp_secret", {
      failureCategory: "git",
      diagnosticId: "diag-1",
    });
    expect(tracker.createIssue).not.toHaveBeenCalled();
    await drain();
    expect(tracker.createIssue).toHaveBeenCalledTimes(1);
    const input = vi.mocked(tracker.createIssue).mock.calls[0][0];
    expect(input.summary).toBe('wardby agent "coder": failed (git)');
    expect(JSON.stringify(input)).not.toContain("ghp_secret");
    expect(created).toEqual([expect.objectContaining({ createdByRunId: "run1", issueKey: "OPS-3" })]);
  });

  it("files when complete ends a coding run budget_exhausted", async () => {
    const { store, tracker, drain } = harness("running");
    await store.complete("run1", "budget_exhausted", RESULT);
    await drain();
    expect(tracker.createIssue).toHaveBeenCalledTimes(1);
  });

  it("queues the run's chores with the terminal write, the job ones after a grace period", async () => {
    const { store, queued } = harness("running");
    await store.terminate("run1", "failed", "coding_failure_git:diag-1", {
      failureCategory: "git",
      diagnosticId: "diag-1",
    });
    expect(queued.map(({ kind }) => kind)).toEqual([...Object.values(CODING_FOLLOW_UP_KINDS), "self_defect"]);
    const [first] = queued;
    const graceEnds = first.nextAttemptAt!.getTime() - Date.now();
    expect(graceEnds).toBeGreaterThan(CODING_FOLLOW_UP_GRACE_MS - 5_000);
    expect(graceEnds).toBeLessThanOrEqual(CODING_FOLLOW_UP_GRACE_MS);
    // The self-defect has no other filer, so no grace.
    expect(queued.find(({ kind }) => kind === "self_defect")!.nextAttemptAt).toBeUndefined();
  });

  it("queues no self-defect for a succeeded run, only the job chores", async () => {
    const { store, queued } = harness("running");
    await store.complete("run1", "succeeded", RESULT);
    expect(queued.map(({ kind }) => kind)).toEqual(Object.values(CODING_FOLLOW_UP_KINDS));
  });

  it("files nothing for a succeeded or cancelled run", async () => {
    const succeeded = harness("running");
    await succeeded.store.complete("run1", "succeeded", RESULT);
    await succeeded.drain();
    expect(succeeded.tracker.createIssue).not.toHaveBeenCalled();
    const cancelled = harness("running");
    await cancelled.store.terminate("run1", "cancelled", "cancelled by operator");
    await cancelled.drain();
    expect(cancelled.tracker.createIssue).not.toHaveBeenCalled();
  });

  it("files nothing when the row was already terminal", async () => {
    const terminated = harness("lost");
    await terminated.store.terminate("run1", "failed", "coding_failure_git:x");
    await terminated.drain();
    expect(terminated.tracker.createIssue).not.toHaveBeenCalled();
    expect(terminated.queued).toEqual([]);
    const completed = harness("budget_exhausted");
    completed.row.codingRun.result = RESULT;
    await completed.store.complete("run1", "budget_exhausted", RESULT);
    await completed.drain();
    expect(completed.tracker.createIssue).not.toHaveBeenCalled();
    expect(completed.queued).toEqual([]);
  });
});
