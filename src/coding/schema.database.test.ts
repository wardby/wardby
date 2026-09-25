import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../core/db.js";
import { afterAll, describe, expect, it } from "vitest";

const db = createPrismaClient();
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
        headRef: `wardby/run-${run.id}`,
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

  it("stores the exact Claude Code provider identifier in profiles and run snapshots", async () => {
    const coding = await db.agent.create({
      data: {
        name: `phase5-claude-coding-${randomUUID()}`,
        systemPrompt: "code safely",
        model: "claude-sonnet-5",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: {
          create: {
            provider: "claude-code",
            repository: "openai/example",
            allowedEgress: [],
            protectedPaths: ["CODEOWNERS"],
          },
        },
      },
      include: { codingProfile: true },
    });
    agentIds.push(coding.id);
    expect(coding.codingProfile?.provider).toBe("claude-code");

    const run = await db.run.create({ data: { agentId: coding.id, status: "cancelled", executionManaged: true } });
    runIds.push(run.id);
    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "Fix the unit test.",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "claude-code",
        model: "claude-sonnet-5",
        timeoutSec: 1800,
        allowedEgress: [],
        protectedPaths: ["CODEOWNERS"],
        budgetReservedUsd: 0.25,
      },
    });

    const snapshot = await db.codingRun.findUniqueOrThrow({ where: { runId: run.id } });
    expect(snapshot.provider).toBe("claude-code");
    await expect(
      db.$executeRaw`UPDATE "CodingAgentProfile" SET "provider" = ${"unknown"} WHERE "agentId" = ${coding.id}`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "CodingRun" SET "provider" = ${"unknown"} WHERE "runId" = ${run.id}`,
    ).rejects.toThrow();
  });
});
