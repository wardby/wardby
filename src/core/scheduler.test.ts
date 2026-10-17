import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "./db.js";
import type { Executor } from "../providers/executor/types.js";
import { findDueCandidates, claimDueRun, markRunFailedFromExecutorError, type SchedulerDb } from "./scheduler.js";
import type { SelfDefectSink } from "./self-defects.js";

const executor: Executor = {
  async start() {},
  async stop() {},
};

interface FakeAgent {
  id: string;
  name: string;
  scheduleEnabled: boolean;
  schedule: string | null;
  timezone: string;
  lastScheduledAt: Date | null;
  kind?: "native" | "coding";
}

function fakeAgentDb(agents: FakeAgent[]): Pick<SchedulerDb, "agent"> {
  return {
    agent: {
      findMany: (async ({ where }: any) =>
        agents.filter(
          (a) =>
            a.scheduleEnabled === where.scheduleEnabled &&
            a.schedule !== null &&
            (!where.kind || (a.kind ?? "native") === where.kind),
        )) as any,
    },
  } as unknown as Pick<SchedulerDb, "agent">;
}

describe("findDueCandidates", () => {
  const now = new Date("2026-09-05T12:16:00.000Z");

  it("returns only enabled, scheduled agents whose window has come due", async () => {
    const due: FakeAgent = {
      id: "a1",
      name: "due-agent",
      scheduleEnabled: true,
      schedule: "*/15 * * * *",
      timezone: "UTC",
      lastScheduledAt: null,
    };
    const notYetDue: FakeAgent = {
      id: "a2",
      name: "not-due-agent",
      scheduleEnabled: true,
      schedule: "*/15 * * * *",
      timezone: "UTC",
      lastScheduledAt: new Date("2026-09-05T12:15:00.000Z"),
    };
    const disabled: FakeAgent = {
      id: "a3",
      name: "disabled-agent",
      scheduleEnabled: false,
      schedule: "*/15 * * * *",
      timezone: "UTC",
      lastScheduledAt: null,
    };
    const manualOnly: FakeAgent = {
      id: "a4",
      name: "manual-agent",
      scheduleEnabled: true,
      schedule: null,
      timezone: "UTC",
      lastScheduledAt: null,
    };
    const coding: FakeAgent = {
      id: "a5",
      name: "coding-agent",
      scheduleEnabled: true,
      schedule: "*/15 * * * *",
      timezone: "UTC",
      lastScheduledAt: null,
      kind: "coding",
    };

    const db = fakeAgentDb([due, notYetDue, disabled, manualOnly, coding]);
    const result = await findDueCandidates(db, now);

    expect(result.map((a) => a.name)).toEqual(["due-agent", "coding-agent"]);
  });
});

describe("markRunFailedFromExecutorError", () => {
  interface FakeRun {
    id: string;
    status: string;
    error: string | null;
    finishedAt: Date | null;
  }

  function fakeRunDb(runs: FakeRun[]): Pick<SchedulerDb, "run"> {
    const byId = new Map(runs.map((r) => [r.id, r]));
    return {
      run: {
        updateMany: (async ({ where, data }: any) => {
          let count = 0;
          for (const run of byId.values()) {
            if (run.id !== where.id) continue;
            if (!where.status.in.includes(run.status)) continue;
            Object.assign(run, data);
            count += 1;
          }
          return { count };
        }) as any,
      },
    } as unknown as Pick<SchedulerDb, "run">;
  }

  it("marks a pending run failed with the executor's error message", async () => {
    const runs: FakeRun[] = [{ id: "r1", status: "pending", error: null, finishedAt: null }];
    const db = fakeRunDb(runs);

    await markRunFailedFromExecutorError(db, "r1", new Error("boom"));

    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toBe("boom");
    expect(runs[0].finishedAt).not.toBeNull();
  });

  it("does not clobber a run that already reached a terminal state through another path", async () => {
    const runs: FakeRun[] = [{ id: "r1", status: "succeeded", error: null, finishedAt: new Date() }];
    const db = fakeRunDb(runs);

    await markRunFailedFromExecutorError(db, "r1", new Error("too late"));

    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].error).toBeNull();
  });

  function selfDefectSink(runs: FakeRun[], trackers: Record<string, unknown> = { jira: { provider: "jira" } }) {
    const fileIssue = vi.fn(async () => ({ outcome: "created" as const, issueKey: "OPS-1", url: "u", seenCount: 1 }));
    const findRun = vi.fn(async ({ where }: any) => {
      const r = runs.find((x) => x.id === where.id);
      return r ? { ...r, agentId: "a1" } : null;
    });
    const sink = {
      db: {
        run: { findUnique: findRun },
        agent: {
          findUnique: vi.fn(async () => ({
            id: "a1",
            name: "nightly",
            defectProjectKey: "OPS",
            defectIssueType: "Bug",
          })),
        },
        agentIssueProject: {
          findUnique: vi.fn(async () => ({
            agentId: "a1",
            provider: "jira",
            projectKey: "OPS",
            access: "write",
            commentVisibilityRole: null,
            creatableIssueTypes: ["Bug"],
          })),
        },
        codingRun: { findUnique: vi.fn(async () => null) },
        $transaction: vi.fn(),
      },
      issueTrackers: trackers,
      options: { fileIssue },
    } as unknown as SelfDefectSink;
    return { sink, fileIssue, findRun };
  }

  it("files a self-defect when it made the run failed", async () => {
    const runs: FakeRun[] = [{ id: "r1", status: "pending", error: null, finishedAt: null }];
    const { sink, fileIssue } = selfDefectSink(runs);

    await markRunFailedFromExecutorError(fakeRunDb(runs), "r1", new Error("boom"), sink);

    expect(fileIssue).toHaveBeenCalledTimes(1);
    expect((fileIssue.mock.calls[0] as unknown[])[0]).toMatchObject({ fingerprint: "self:a1:failed:unknown" });
  });

  it("files nothing when the run was already terminal", async () => {
    const runs: FakeRun[] = [{ id: "r1", status: "failed", error: "x", finishedAt: new Date() }];
    const { sink, fileIssue, findRun } = selfDefectSink(runs);

    await markRunFailedFromExecutorError(fakeRunDb(runs), "r1", new Error("again"), sink);

    expect(fileIssue).not.toHaveBeenCalled();
    expect(findRun).not.toHaveBeenCalled();
  });

  it("makes no extra query without a configured tracker", async () => {
    const runs: FakeRun[] = [{ id: "r1", status: "pending", error: null, finishedAt: null }];
    const { sink, fileIssue, findRun } = selfDefectSink(runs, {});

    await markRunFailedFromExecutorError(fakeRunDb(runs), "r1", new Error("boom"), sink);

    expect(runs[0].status).toBe("failed");
    expect(findRun).not.toHaveBeenCalled();
    expect(fileIssue).not.toHaveBeenCalled();
  });
});

// claimDueRun exercises FOR UPDATE SKIP LOCKED + a real transaction — that
// concurrency behavior can't be faithfully faked, so this suite runs
// against a real local Postgres and is skipped without DATABASE_URL (same
// pattern as the OpenAI contract test).
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    "[wardby tests] DATABASE_URL not set — skipping the at-most-once claimDueRun " +
      "concurrency test (FOR UPDATE SKIP LOCKED against two racing ticks). This is one " +
      "of the highest-risk pieces of Phase 2; set DATABASE_URL before trusting a " +
      "scheduler change based on a green run that skipped it.",
  );
}

describe.skipIf(!databaseUrl)("claimDueRun (database)", () => {
  const db = createPrismaClient();
  const createdAgentIds: string[] = [];

  afterAll(async () => {
    // A live scheduler polling this same dev database would otherwise pick
    // up these leftover scheduleEnabled test agents and try to fire them.
    await db.run.deleteMany({ where: { agentId: { in: createdAgentIds } } });
    await db.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await db.$disconnect();
  });

  async function makeScheduledAgent(overrides: Partial<{ schedule: string; timezone: string }> = {}) {
    const agent = await db.agent.create({
      data: {
        name: `sched-test-${randomUUID()}`,
        systemPrompt: "sys",
        model: "m",
        budgetUsd: 10,
        schedule: overrides.schedule ?? "*/15 * * * *",
        timezone: overrides.timezone ?? "UTC",
        scheduleEnabled: true,
      },
    });
    createdAgentIds.push(agent.id);
    return agent;
  }

  it("creates exactly one Run when two ticks race over the same due agent", async () => {
    const agent = await makeScheduledAgent();
    const now = new Date("2026-09-05T12:16:00.000Z");

    const [first, second] = await Promise.all([
      claimDueRun(db, executor, agent.id, now),
      claimDueRun(db, executor, agent.id, now),
    ]);

    const runIds = [first, second].filter((id): id is string => id !== null);
    expect(runIds.length).toBe(1);

    const runs = await db.run.findMany({ where: { agentId: agent.id } });
    expect(runs.length).toBe(1);
    expect(runs[0].trigger).toBe("scheduled");

    const updated = await db.agent.findUnique({ where: { id: agent.id } });
    expect(updated?.lastScheduledAt).toEqual(new Date("2026-09-05T12:15:00.000Z"));
  });

  it("returns null and creates no Run when the agent isn't due", async () => {
    const agent = await makeScheduledAgent();
    await db.agent.update({
      where: { id: agent.id },
      data: { lastScheduledAt: new Date("2026-09-05T12:15:00.000Z") },
    });

    const runId = await claimDueRun(db, executor, agent.id, new Date("2026-09-05T12:16:00.000Z"));

    expect(runId).toBeNull();
    const runs = await db.run.findMany({ where: { agentId: agent.id } });
    expect(runs.length).toBe(0);
  });

  it("a coding agent whose model is unavailable gets a terminal failed Run and its schedule advances", async () => {
    const agent = await makeScheduledAgent();
    await db.agent.update({
      where: { id: agent.id },
      data: {
        kind: "coding",
        model: "gpt-not-in-any-catalog",
        codingProfile: {
          create: {
            repository: "openai/wardby",
            defaultTask: "Update dependencies",
            allowedEgress: [],
            protectedPaths: [],
          },
        },
      },
    });
    const start = vi.fn(async () => undefined);
    const now = new Date("2026-09-05T12:16:00.000Z");

    const runId = await claimDueRun(db, { start, async stop() {} }, agent.id, now);

    expect(runId).not.toBeNull();
    const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/^model_unavailable: .*reason: not_in_catalog/);
    expect(run?.finishedAt).toEqual(now);
    expect(run?.codingRun).toBeNull();
    expect(start).not.toHaveBeenCalled();
    // The claim committed with the run, so the next tick does not fire this window again.
    const updated = await db.agent.findUnique({ where: { id: agent.id } });
    expect(updated?.lastScheduledAt).toEqual(new Date("2026-09-05T12:15:00.000Z"));
    expect(await claimDueRun(db, { start, async stop() {} }, agent.id, now)).toBeNull();
  });

  it("claims coding agents and snapshots their default task for routing", async () => {
    const agent = await makeScheduledAgent();
    await db.agent.update({
      where: { id: agent.id },
      data: {
        kind: "coding",
        model: "gpt-5.6-luna",
        codingProfile: {
          create: {
            repository: "openai/wardby",
            defaultTask: "Update dependencies",
            allowedEgress: [],
            protectedPaths: [".github/workflows/**"],
          },
        },
      },
    });

    const runId = await claimDueRun(db, executor, agent.id, new Date("2026-09-05T12:16:00.000Z"));

    expect(runId).not.toBeNull();
    const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
    expect(run?.executionManaged).toBe(true);
    // The agent's own prompt ("sys") rides ahead of the default task; see composeCodingTask.
    expect(run?.codingRun?.task).toBe(
      "Standing instructions for this coding agent:\nsys\n\nRequest:\nUpdate dependencies",
    );
  });

  async function makeCodingAgent() {
    const agent = await makeScheduledAgent();
    await db.agent.update({
      where: { id: agent.id },
      data: {
        kind: "coding",
        model: "gpt-5.6-luna",
        codingProfile: {
          create: {
            repository: "openai/wardby",
            defaultTask: "Update dependencies",
            allowedEgress: [],
            protectedPaths: [".github/workflows/**"],
          },
        },
      },
    });
    return agent;
  }

  it("adds the repository's knowledge index to a coding run's task", async () => {
    const agent = await makeCodingAgent();
    const readCodingRepositoryFile = vi.fn(async (input: { path: string }) =>
      input.path === "docs/knowledge/index.md" ? "# Pitfalls\n\n* [A](a.md) - a\n" : null,
    );

    const runId = await claimDueRun(
      db,
      { ...executor, readCodingRepositoryFile },
      agent.id,
      new Date("2026-09-05T12:16:00.000Z"),
    );

    const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
    expect(readCodingRepositoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "openai/wardby", path: "docs/knowledge/index.md" }),
    );
    expect(run?.codingRun?.task).toMatch(
      /^Standing instructions for this coding agent:\nsys\n\nArchitecture knowledge[\s\S]*\* \[A\]\(a\.md\) - a[\s\S]*\n\nRequest:\nUpdate dependencies$/,
    );
  });

  it("reads the index from the folder .wardby/knowledge.yaml names", async () => {
    const agent = await makeCodingAgent();
    const files: Record<string, string> = {
      ".wardby/knowledge.yaml": "path: .okf\n",
      ".okf/index.md": "# Pitfalls\n\n* [B](b.md) - b\n",
      "docs/knowledge/index.md": "# Pitfalls\n\n* [A](a.md) - a\n",
    };
    const readCodingRepositoryFile = vi.fn(async (input: { path: string }) => files[input.path] ?? null);

    const runId = await claimDueRun(
      db,
      { ...executor, readCodingRepositoryFile },
      agent.id,
      new Date("2026-09-05T12:16:00.000Z"),
    );

    const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
    expect(run?.codingRun?.task).toContain("files live in .okf/.");
    expect(run?.codingRun?.task).toContain(".okf/index.md:\n# Pitfalls\n\n* [B](b.md) - b");
    expect(run?.codingRun?.task).not.toContain("[A](a.md)");
  });

  it("falls back to docs/knowledge/ when .wardby/knowledge.yaml is invalid", async () => {
    const agent = await makeCodingAgent();
    const files: Record<string, string> = {
      ".wardby/knowledge.yaml": "path: ../outside\n",
      "docs/knowledge/index.md": "# Pitfalls\n\n* [A](a.md) - a\n",
    };
    const readCodingRepositoryFile = vi.fn(async (input: { path: string }) => files[input.path] ?? null);

    const runId = await claimDueRun(
      db,
      { ...executor, readCodingRepositoryFile },
      agent.id,
      new Date("2026-09-05T12:16:00.000Z"),
    );

    const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
    expect(run?.codingRun?.task).toContain("docs/knowledge/index.md:\n# Pitfalls\n\n* [A](a.md) - a");
  });

  it("still dispatches a coding run, without the note, when the index read fails", async () => {
    const agent = await makeCodingAgent();
    const readCodingRepositoryFile = vi.fn(async () => {
      throw new Error("github_unavailable");
    });

    const runId = await claimDueRun(
      db,
      { ...executor, readCodingRepositoryFile },
      agent.id,
      new Date("2026-09-05T12:16:00.000Z"),
    );

    const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
    expect(readCodingRepositoryFile).toHaveBeenCalled();
    expect(run?.codingRun?.task).toBe(
      "Standing instructions for this coding agent:\nsys\n\nRequest:\nUpdate dependencies",
    );
  });
});
