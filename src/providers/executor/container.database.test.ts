import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../core/db.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaContainerExecutionStore } from "./container.js";

const db = createPrismaClient();
const suffix = randomUUID();
const principalId = `container-principal-${suffix}`;
const agentId = `container-agent-${suffix}`;

// Tests that create active (slot-holding) or queued coding runs live in
// src/core/coding-concurrency.database.test.ts instead: they depend on
// global slot/queue state and race each other across parallel test files.
describe.skipIf(!process.env.DATABASE_URL)("PrismaContainerExecutionStore (PostgreSQL)", () => {
  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: principalId } });
    await db.$disconnect();
  });

  it("persists a sanitized failure category and opaque diagnostic ID separately from the terminal state", async () => {
    const failedRunId = `container-failed-${randomUUID()}`;
    try {
      await db.run.create({ data: { id: failedRunId, agentId, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: failedRunId,
          task: "Never persist this task in failure metadata.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${failedRunId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });

      const store = new PrismaContainerExecutionStore(db);
      await store.terminate(failedRunId, "failed", "coding_failure_artifact:coding_diag_opaque", {
        failureCategory: "artifact",
        diagnosticId: "coding_diag_opaque",
      });

      await expect(db.codingRun.findUniqueOrThrow({ where: { runId: failedRunId } })).resolves.toMatchObject({
        failureCategory: "artifact",
        diagnosticId: "coding_diag_opaque",
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: failedRunId } });
      await db.run.deleteMany({ where: { id: failedRunId } });
    }
  });

  it("refuses to claim a run that is no longer pending/running, and leaves no claim behind", async () => {
    const alreadyFailedRunId = `container-already-failed-${randomUUID()}`;
    try {
      await db.run.create({
        data: {
          id: alreadyFailedRunId,
          agentId,
          executionManaged: true,
          status: "failed",
          error: "some_other_failure",
        },
      });
      await db.codingRun.create({
        data: {
          runId: alreadyFailedRunId,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${alreadyFailedRunId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });

      const store = new PrismaContainerExecutionStore(db);
      await expect(store.claimProvisioning(alreadyFailedRunId, "claim-late")).resolves.toBe("unavailable");

      const coding = await db.codingRun.findUniqueOrThrow({ where: { runId: alreadyFailedRunId } });
      expect(coding.jobBackend).toBeNull();
      expect(coding.jobHandle).toBeNull();
      const run = await db.run.findUniqueOrThrow({ where: { id: alreadyFailedRunId } });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("some_other_failure");
    } finally {
      await db.codingRun.deleteMany({ where: { runId: alreadyFailedRunId } });
      await db.run.deleteMany({ where: { id: alreadyFailedRunId } });
    }
  });
});
