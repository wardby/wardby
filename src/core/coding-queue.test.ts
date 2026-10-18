import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { CODING_QUEUE_TIMEOUT_ERROR, drainCodingQueue, type CodingQueueDb } from "./coding-queue.js";
import type { SelfDefectSink } from "./self-defects.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");

interface FakeRun {
  id: string;
  status: string;
  error: string | null;
  finishedAt: Date | null;
  failureCategory: string | null;
}

/** One queued coding run, expired; no free slots afterwards matter (count says the pool is full). */
function fakeQueue(runs: FakeRun[]) {
  const db = {
    run: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        const run = runs.find((r) => r.id === where.id && r.status === where.status);
        if (!run) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    codingRun: {
      findMany: vi.fn(async ({ where }: any) => (where.queuedAt?.lt ? runs.map((r) => ({ runId: r.id })) : [])),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(
          runs.find((r) => r.id === where.runId)!,
          data,
        );
      }),
      count: vi.fn(async () => 10),
    },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(db),
  };
  return db as unknown as CodingQueueDb;
}

function sink(runs: FakeRun[], trackers: Record<string, unknown> = { jira: { provider: "jira" } }) {
  const fileIssue = vi.fn(async () => ({ outcome: "created" as const, issueKey: "OPS-1", url: "u", seenCount: 1 }));
  const findRun = vi.fn(async ({ where }: any) => {
    const r = runs.find((x) => x.id === where.id);
    return r ? { id: r.id, agentId: "a1", status: r.status, error: r.error, finishedAt: r.finishedAt } : null;
  });
  const selfDefects = {
    db: {
      run: { findUnique: findRun },
      agent: { findUnique: async () => ({ id: "a1", name: "coder", defectProjectKey: "OPS", defectIssueType: "Bug" }) },
      agentIssueProject: {
        findUnique: async () => ({
          agentId: "a1",
          provider: "jira",
          projectKey: "OPS",
          access: "write",
          commentVisibilityRole: null,
          creatableIssueTypes: ["Bug"],
        }),
      },
      codingRun: {
        findUnique: async ({ where }: any) => ({
          failureCategory: runs.find((r) => r.id === where.runId)?.failureCategory ?? null,
        }),
      },
      $transaction: vi.fn(),
    },
    issueTrackers: trackers,
    options: { fileIssue },
  } as unknown as SelfDefectSink;
  return { selfDefects, fileIssue, findRun };
}

const executor: Executor = { async start() {}, async stop() {} };

function queuedRun(status = "pending"): FakeRun {
  return { id: "r1", status, error: null, finishedAt: null, failureCategory: null };
}

describe("drainCodingQueue self-defects", () => {
  it("files a coding_queue_timeout defect for a run this drain timed out", async () => {
    const runs = [queuedRun()];
    const { selfDefects, fileIssue } = sink(runs);

    const result = await drainCodingQueue({
      db: fakeQueue(runs),
      executor,
      maxConcurrent: 1,
      queueTimeoutSec: 60,
      now: () => NOW,
      selfDefects,
    });

    expect(result.timedOut).toBe(1);
    expect(runs[0].error).toBe(CODING_QUEUE_TIMEOUT_ERROR);
    expect(fileIssue).toHaveBeenCalledTimes(1);
    expect((fileIssue.mock.calls[0] as unknown[])[0]).toMatchObject({
      fingerprint: "self:a1:failed:coding_queue_timeout",
    });
  });

  it("files nothing when another drain already ended the run", async () => {
    const runs = [queuedRun("failed")];
    const { selfDefects, fileIssue, findRun } = sink(runs);

    const result = await drainCodingQueue({
      db: fakeQueue(runs),
      executor,
      maxConcurrent: 1,
      queueTimeoutSec: 60,
      now: () => NOW,
      selfDefects,
    });

    expect(result.timedOut).toBe(0);
    expect(findRun).not.toHaveBeenCalled();
    expect(fileIssue).not.toHaveBeenCalled();
  });

  it("makes no extra query without a configured tracker", async () => {
    const runs = [queuedRun()];
    const { selfDefects, fileIssue, findRun } = sink(runs, {});

    await drainCodingQueue({
      db: fakeQueue(runs),
      executor,
      maxConcurrent: 1,
      queueTimeoutSec: 60,
      now: () => NOW,
      selfDefects,
    });

    expect(runs[0].status).toBe("failed");
    expect(findRun).not.toHaveBeenCalled();
    expect(fileIssue).not.toHaveBeenCalled();
  });
});

describe("drainCodingQueue queue-timeout cleanup", () => {
  it("asks the executor to clean up each run this drain timed out, after failing it", async () => {
    const runs = [queuedRun()];
    const seen: Array<{ runId: string; status: string }> = [];
    const cleaning: Executor = {
      ...executor,
      cleanupQueueTimeout: vi.fn(async (runId: string) => {
        seen.push({ runId, status: runs[0].status });
      }),
    };

    await drainCodingQueue({
      db: fakeQueue(runs),
      executor: cleaning,
      maxConcurrent: 1,
      queueTimeoutSec: 60,
      now: () => NOW,
    });

    expect(seen).toEqual([{ runId: "r1", status: "failed" }]);
  });

  it("does not clean up a run another drain already ended", async () => {
    const runs = [queuedRun("failed")];
    const cleanupQueueTimeout = vi.fn(async () => {});

    await drainCodingQueue({
      db: fakeQueue(runs),
      executor: { ...executor, cleanupQueueTimeout },
      maxConcurrent: 1,
      queueTimeoutSec: 60,
      now: () => NOW,
    });

    expect(cleanupQueueTimeout).not.toHaveBeenCalled();
  });

  it("keeps draining when the cleanup throws", async () => {
    const runs = [queuedRun(), { ...queuedRun(), id: "r2" }];
    const cleanupQueueTimeout = vi.fn(async () => {
      throw new Error("host down");
    });

    const result = await drainCodingQueue({
      db: fakeQueue(runs),
      executor: { ...executor, cleanupQueueTimeout },
      maxConcurrent: 1,
      queueTimeoutSec: 60,
      now: () => NOW,
    });

    expect(result.timedOut).toBe(2);
    expect(cleanupQueueTimeout).toHaveBeenCalledTimes(2);
  });
});
