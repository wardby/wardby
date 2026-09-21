import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Executor } from "../providers/executor/types.js";
import { findDueCandidates, claimDueRun, markRunFailedFromExecutorError, type SchedulerDb } from "./scheduler.js";

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
  const db = new PrismaClient();
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
    expect(run?.codingRun?.task).toBe("Update dependencies");
  });
});
