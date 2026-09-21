import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaContainerExecutionStore } from "./container.js";

const db = new PrismaClient();
const suffix = randomUUID();
const principalId = `container-principal-${suffix}`;
const agentId = `container-agent-${suffix}`;
const runId = `container-run-${suffix}`;

describe.skipIf(!process.env.DATABASE_URL)("PrismaContainerExecutionStore (PostgreSQL)", () => {
  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId } });
    await db.run.deleteMany({ where: { id: runId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: principalId } });
    await db.$disconnect();
  });

  it("admits one provisioning owner and atomically persists its handle and terminal result", async () => {
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
    await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
    await db.codingRun.create({
      data: {
        runId,
        task: "Fix it.",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 900,
        allowedEgress: [],
        protectedPaths: ["CODEOWNERS"],
        workerImage: `sha256:realdbtest${"0".repeat(50)}`,
        budgetReservedUsd: 1,
      },
    });

    const store = new PrismaContainerExecutionStore(db);
    await expect(store.load(runId)).resolves.toMatchObject({
      workerImage: `sha256:realdbtest${"0".repeat(50)}`,
    });
    const [first, second] = await Promise.all([
      store.claimProvisioning(runId, "claim-a"),
      store.claimProvisioning(runId, "claim-b"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const winner = first ? "claim-a" : "claim-b";
    await expect(
      store.persistHandle(runId, winner === "claim-a" ? "claim-b" : "claim-a", { backend: "docker", id: "job-1" }),
    ).rejects.toThrow("coding_job_handle_conflict");
    await store.persistHandle(runId, winner, { backend: "docker", id: "job-1" });
    await expect(store.load(runId)).resolves.toMatchObject({
      status: "running",
      provisioningClaim: null,
      jobHandle: { backend: "docker", id: "job-1" },
    });

    const result = {
      schemaVersion: 1 as const,
      outcome: "no_changes" as const,
      repository: "openai/example",
      baseRef: "main",
      summary: "Nothing to change.",
      tests: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    };
    await store.complete(runId, "succeeded", result);
    await store.complete(runId, "succeeded", result);
    const terminal = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
    expect(terminal.status).toBe("succeeded");
    expect(terminal.codingRun?.result).toEqual(result);
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
});
