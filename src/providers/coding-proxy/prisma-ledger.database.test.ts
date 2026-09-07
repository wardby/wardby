import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaProxyLedger } from "./prisma-ledger.js";

const db = new PrismaClient();
const suffix = randomUUID();
const agentId = `proxy-agent-${suffix}`;
const runId = `proxy-run-${suffix}`;
const sessionId = `proxy-session-${suffix}`;

describe.skipIf(!process.env.DATABASE_URL)("PrismaProxyLedger (PostgreSQL)", () => {
  afterAll(async () => {
    await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${sessionId}`;
    await db.codingRun.deleteMany({ where: { runId } });
    await db.run.deleteMany({ where: { id: runId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("serializes admission and keeps completion idempotent across adapter restarts", async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
    });
    await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
    await db.codingRun.create({
      data: {
        runId,
        task: "test",
        repository: "openai/example",
        baseRef: "main",
        headRef: `reevo/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 60,
        allowedEgress: [],
        protectedPaths: [],
        budgetReservedUsd: 0.0002,
      },
    });
    const ledger = new PrismaProxyLedger(db);
    await ledger.createSession({
      id: sessionId,
      runId,
      capabilityHash: `hash-${suffix}`,
      credentialRef: "openai/test",
      allowedModels: ["gpt-5.6-luna"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 0.0002,
    });
    const request = (id: string) => ({
      id: `${id}-${suffix}`,
      sessionId,
      requestKey: id,
      requestFingerprint: `fingerprint-${id}`,
      model: "gpt-5.6-luna",
      reservationUsd: 0.0001,
      pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
      now: new Date(),
    });
    const [first, second] = await Promise.all([ledger.reserve(request("a")), ledger.reserve(request("b"))]);
    const admitted = [first, second].filter((result) => result.outcome === "reserved");
    expect(admitted).toHaveLength(1);
    expect([first.outcome, second.outcome]).toContain("budget_exhausted");

    const requestId = admitted[0].outcome === "reserved" ? admitted[0].request.id : "";
    const usage = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, cacheWriteTokens: 0, reasoningTokens: 1 };
    await ledger.complete(requestId, usage, 0.00005, 200);
    await new PrismaProxyLedger(db).complete(requestId, usage, 0.00005, 200);

    const persisted = await new PrismaProxyLedger(db).getRequest(requestId);
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    expect(persisted).toMatchObject({ status: "completed", actualCostUsd: 0.00005, usage });
    expect(run.tokensIn).toBe(10);
    expect(run.tokensOut).toBe(4);
    expect(Number(run.costUsd)).toBe(0.00005);
  });
});
