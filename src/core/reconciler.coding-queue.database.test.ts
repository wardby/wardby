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
