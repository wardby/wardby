import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

const db = new PrismaClient();
const agentIds: string[] = [];
const runIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("Phase 5 coding schema (PostgreSQL)", () => {
  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  it("preserves native defaults and stores an immutable coding-run snapshot", async () => {
    const native = await db.agent.create({
      data: { name: `phase5-native-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(native.id);
    expect(native.kind).toBe("native");

    const coding = await db.agent.create({
      data: {
        name: `phase5-coding-${randomUUID()}`,
        systemPrompt: "code safely",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: {
          create: {
            repository: "openai/example",
            allowedEgress: ["registry.npmjs.org"],
            protectedPaths: [".github/workflows/**", "CODEOWNERS"],
          },
        },
      },
      include: { codingProfile: true },
    });
    agentIds.push(coding.id);
    expect(coding.codingProfile).toMatchObject({ provider: "codex", baseRef: "main", timeoutSec: 1800 });

    const run = await db.run.create({
      data: { agentId: coding.id, status: "cancelled", executionManaged: true },
    });
    runIds.push(run.id);
    expect(run.executionManaged).toBe(true);

    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "Fix the unit test.",
        repository: "openai/example",
        baseRef: "main",
        headRef: `reevo/run-${run.id}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 1800,
        allowedEgress: ["registry.npmjs.org"],
        protectedPaths: [".github/workflows/**", "CODEOWNERS"],
        budgetReservedUsd: 0.25,
      },
    });

    const snapshot = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { codingRun: true } });
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.codingRun).toMatchObject({
      repository: "openai/example",
      provider: "codex",
      model: "gpt-5.6-luna",
      resultSchema: 1,
    });
  });
});
