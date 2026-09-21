import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient, type RunStatus } from "@prisma/client";
import { createRunTask, getTask, cancelTask } from "./manager.js";

// createRunTask/getTask/cancelTask read and write real Task + Run rows
// (Run requires a real Agent FK) — run against a real local Postgres,
// skipped without DATABASE_URL (same pattern as lease.test.ts / Phase 2).
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    "[wardby tests] DATABASE_URL not set — skipping the MCP task-manager tests (Run.status -> " +
      "Task lifecycle mapping). Set DATABASE_URL before trusting an MCP task change based on a " +
      "green run that skipped it.",
  );
}

const TEST_PRINCIPAL_ID = "task-mgr-test-principal";

describe.skipIf(!databaseUrl)("MCP task manager (database)", () => {
  const db = new PrismaClient();
  const agentIds: string[] = [];
  const runIds: string[] = [];
  const taskIds: string[] = [];

  afterAll(async () => {
    await db.task.deleteMany({ where: { id: { in: taskIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  async function newRun(
    overrides: Partial<{
      status: RunStatus;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      error: string | null;
      finalText: string | null;
    }> = {},
  ) {
    const agent = await db.agent.create({
      data: { name: `task-mgr-test-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 10 },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({
      data: {
        agentId: agent.id,
        status: overrides.status ?? "pending",
        tokensIn: overrides.tokensIn ?? 0,
        tokensOut: overrides.tokensOut ?? 0,
        costUsd: overrides.costUsd ?? 0,
        error: overrides.error ?? null,
        finalText: overrides.finalText ?? null,
      },
    });
    runIds.push(run.id);
    return run;
  }

  it("createRunTask persists a Task row before returning", async () => {
    const run = await newRun({ status: "pending" });
    const created = await createRunTask(run.id, TEST_PRINCIPAL_ID, db, 60_000);
    taskIds.push(created.taskId);

    expect(created.resultType).toBe("task");
    expect(created.status).toBe("working");

    const row = await db.task.findUnique({ where: { id: created.taskId } });
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("run");
    expect(row?.runId).toBe(run.id);
    expect(row?.status).toBe("working");
  });

  describe.each<{ runStatus: RunStatus; expectTaskStatus: "working" | "completed" | "failed" | "cancelled" }>([
    { runStatus: "pending", expectTaskStatus: "working" },
    { runStatus: "running", expectTaskStatus: "working" },
    { runStatus: "succeeded", expectTaskStatus: "completed" },
    { runStatus: "budget_exhausted", expectTaskStatus: "completed" },
    { runStatus: "refused", expectTaskStatus: "completed" },
    { runStatus: "failed", expectTaskStatus: "failed" },
    { runStatus: "lost", expectTaskStatus: "failed" },
    { runStatus: "cancelled", expectTaskStatus: "cancelled" },
  ])("getTask maps Run.status=$runStatus", ({ runStatus, expectTaskStatus }) => {
    it(`-> task status ${expectTaskStatus}`, async () => {
      const run = await newRun({
        status: runStatus,
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.01,
        error:
          runStatus === "failed" || runStatus === "lost" || runStatus === "refused" ? "something went wrong" : null,
        finalText: runStatus === "succeeded" || runStatus === "budget_exhausted" ? "the answer" : null,
      });
      const created = await createRunTask(run.id, TEST_PRINCIPAL_ID, db, 60_000);
      taskIds.push(created.taskId);

      const result = await getTask(created.taskId, db);
      expect(result.resultType).toBe("complete");
      expect(result.status).toBe(expectTaskStatus);

      if (expectTaskStatus === "completed") {
        expect("result" in result && result.result).toBeDefined();
      }
      if (expectTaskStatus === "failed") {
        expect("error" in result && result.error?.message).toBe("something went wrong");
      }
    });
  });

  it("budget_exhausted is a successful terminal (completed), not an error", async () => {
    const run = await newRun({ status: "budget_exhausted", finalText: "partial summary", costUsd: 0.05 });
    const created = await createRunTask(run.id, TEST_PRINCIPAL_ID, db, 60_000);
    taskIds.push(created.taskId);
    const result = await getTask(created.taskId, db);
    expect(result.status).toBe("completed");
    expect("error" in result).toBe(false);
  });

  it("returns only the validated coding result for a completed coding task", async () => {
    const agent = await db.agent.create({
      data: {
        name: `task-mgr-coding-${randomUUID()}`,
        systemPrompt: "x",
        model: "gpt-5.6-terra",
        budgetUsd: 10,
        kind: "coding",
        codingProfile: {
          create: {
            repository: "openai/wardby",
            baseRef: "main",
            allowedEgress: [],
            protectedPaths: ["CODEOWNERS"],
          },
        },
      },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({ data: { agentId: agent.id, status: "succeeded" } });
    runIds.push(run.id);
    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "Verify the result projection",
        repository: "openai/wardby",
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "codex",
        model: "gpt-5.6-terra",
        timeoutSec: 900,
        allowedEgress: [],
        protectedPaths: ["CODEOWNERS"],
        jobBackend: "docker",
        jobHandle: "container-private",
        budgetReservedUsd: 10,
        result: {
          schemaVersion: 1,
          outcome: "no_changes",
          repository: "openai/wardby",
          baseRef: "main",
          summary: "No changes; github_pat_abcdefghijklmnopqrstuvwxyz123456",
          tests: [{ command: "npm test", outcome: "passed" }],
          usage: { tokensIn: 1, tokensOut: 2, costUsd: 0.01 },
        },
      },
    });
    const created = await createRunTask(run.id, TEST_PRINCIPAL_ID, db, 60_000);
    taskIds.push(created.taskId);

    const result = await getTask(created.taskId, db);
    expect(result).toMatchObject({
      status: "completed",
      result: { outcome: "no_changes", summary: "No changes; [REDACTED]" },
    });
    expect("result" in result && result.result).not.toHaveProperty("jobHandle");
    expect("result" in result && result.result).not.toHaveProperty("protectedPaths");
  });

  it("cancelTask invokes the stop hook for a still-running task", async () => {
    const run = await newRun({ status: "running" });
    const created = await createRunTask(run.id, TEST_PRINCIPAL_ID, db, 60_000);
    taskIds.push(created.taskId);

    let stoppedRunId: string | undefined;
    await cancelTask(created.taskId, db, async (runId) => {
      stoppedRunId = runId;
    });

    expect(stoppedRunId).toBe(run.id);
    const result = await getTask(created.taskId, db);
    expect(result.status).toBe("cancelled");
  });

  it("cancelTask tolerates a run already terminal (no-op, does not invoke the stop hook)", async () => {
    const run = await newRun({ status: "succeeded", finalText: "done" });
    const created = await createRunTask(run.id, TEST_PRINCIPAL_ID, db, 60_000);
    taskIds.push(created.taskId);

    let stopHookCalled = false;
    await cancelTask(created.taskId, db, async () => {
      stopHookCalled = true;
    });

    expect(stopHookCalled).toBe(false);
    const result = await getTask(created.taskId, db);
    expect(result.status).toBe("completed");
  });
});
