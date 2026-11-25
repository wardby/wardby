import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../core/db.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaProxyLedger } from "./prisma-ledger.js";
import { PrismaContainerExecutionStore } from "../executor/container.js";
import { CodingProxy, type ProxyResponseSink } from "./proxy.js";
import { shippedCatalog } from "../llm/catalog.js";
import { entryOf } from "../llm/catalog-types.js";

const db = createPrismaClient();
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
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 60,
        allowedEgress: [],
        protectedPaths: [],
        budgetReservedUsd: 0.0002,
        budgetLimitedBy: "week",
      },
    });
    const ledger = new PrismaProxyLedger(db);
    await ledger.createSession({
      id: sessionId,
      runId,
      capabilityHash: `hash-${suffix}`,
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["gpt-5.6-luna"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 0.0002,
      registryTokenHash: `registry-hash-${suffix}`,
    });
    expect(await ledger.findSessionByCapabilityHash(`hash-${suffix}`)).toMatchObject({
      protocol: "openai-responses",
      // Created without a level, as a session from before run steps detail.
      runStepsLevel: null,
      // Not a workflow run (#582), and no Skill tool.
      workflow: false,
      skills: false,
      requestRefusal: null,
      budgetExhaustedAt: null,
      upstreamFailure: null,
      // Created without terms, as a session from before the catalog.
      terms: null,
    });
    expect(await ledger.budgetExhausted(sessionId)).toBe(false);
    expect(await ledger.upstreamFailure(sessionId)).toBeNull();
    await ledger.recordUpstreamFailure(sessionId, "project_spend_limit_exceeded");
    await new PrismaProxyLedger(db).recordUpstreamFailure(sessionId, "server_error");
    expect(await ledger.upstreamFailure(sessionId)).toBe("project_spend_limit_exceeded");
    expect((await ledger.findSessionByCapabilityHash(`hash-${suffix}`))?.upstreamFailure).toBe(
      "project_spend_limit_exceeded",
    );
    expect(await ledger.upstreamFailure(`missing-${suffix}`)).toBeNull();
    const request = (id: string) => ({
      id: `${id}-${suffix}`,
      sessionId,
      requestKey: id,
      requestFingerprint: `fingerprint-${id}`,
      model: "gpt-5.6-luna",
      reservationUsd: 0.0001,
      ceilingUsd: 0.0003,
      reservationBasis: "cached" as const,
      pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
      now: new Date(),
    });
    const [first, second] = await Promise.all([ledger.reserve(request("a")), ledger.reserve(request("b"))]);
    const admitted = [first, second].filter((result) => result.outcome === "reserved");
    expect(admitted).toHaveLength(1);
    expect([first.outcome, second.outcome]).toContain("budget_exhausted");
    const refusedAt = (await ledger.findSessionByCapabilityHash(`hash-${suffix}`))?.budgetExhaustedAt;
    expect(refusedAt).toBeInstanceOf(Date);
    expect(await ledger.budgetExhausted(sessionId)).toBe(true);
    expect(await ledger.budgetExhausted(`missing-${suffix}`)).toBe(false);
    const later = await ledger.reserve({ ...request("c"), now: new Date(Date.now() + 5_000) });
    expect(later.outcome).toBe("budget_exhausted");
    expect((await ledger.findSessionByCapabilityHash(`hash-${suffix}`))?.budgetExhaustedAt).toEqual(refusedAt);

    // The proxy records the first refusal's numbers on its session only (it has no access to
    // RunBudgetEvent); the control plane copies them into the run's budget events, once.
    const refusal = await ledger.budgetRefusal(sessionId);
    expect(refusal).toEqual({
      source: "proxy",
      budgetUsd: 0.0002,
      spentUsd: 0,
      heldReservedUsd: 0.0001,
      heldUncertainUsd: 0,
      refusedHoldUsd: 0.0001,
      refusedHoldBasis: "cached",
      refusedHoldCeilingUsd: 0.0003,
      model: "gpt-5.6-luna",
      turn: 1,
    });
    expect(await ledger.budgetRefusal(`missing-${suffix}`)).toBeNull();
    expect(await db.runBudgetEvent.count({ where: { runId } })).toBe(0);
    const store = new PrismaContainerExecutionStore(db);
    await store.recordBudgetRefusal(runId, sessionId);
    await store.recordBudgetRefusal(runId, sessionId);
    expect(await db.runBudgetEvent.findMany({ where: { runId } })).toEqual([
      expect.objectContaining({
        kind: "refused",
        limit: "week",
        details: expect.objectContaining({
          source: "proxy",
          turn: 1,
          refusedHoldUsd: 0.0001,
          refusedHoldBasis: "cached",
          refusedHoldCeilingUsd: 0.0003,
        }),
      }),
    ]);

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
    // One completed proxied call (completed twice, idempotently) is one turn.
    expect(run.turns).toBe(1);
  });

  it("stores a session's run steps level and reads it back", async () => {
    const dRun = `level-run-${suffix}`;
    const dSession = `level-session-${suffix}`;
    const dAgent = `level-agent-${suffix}`;
    const ledger = new PrismaProxyLedger(db);
    await db.agent.create({
      data: { id: dAgent, name: dAgent, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
    });
    await db.run.create({ data: { id: dRun, agentId: dAgent, executionManaged: true } });
    try {
      await db.codingRun.create({
        data: {
          runId: dRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${dRun}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 1,
        },
      });
      await ledger.createSession({
        id: dSession,
        runId: dRun,
        capabilityHash: `level-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: ["gpt-5.6-luna"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        registryTokenHash: `level-registry-${suffix}`,
        runStepsLevel: "detail",
        workflow: true,
        skills: true,
      });
      expect(await ledger.findSessionByCapabilityHash(`level-hash-${suffix}`)).toMatchObject({
        runStepsLevel: "detail",
        workflow: true,
        skills: true,
      });
      // The first refusal is kept; a later one does not replace it.
      await ledger.recordRequestRefusal(dSession, "tools_not_allowed");
      await ledger.recordRequestRefusal(dSession, "model_not_allowed");
      expect(await ledger.requestRefusal(dSession)).toBe("tools_not_allowed");
    } finally {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${dSession}`;
      await db.codingRun.deleteMany({ where: { runId: dRun } });
      await db.run.deleteMany({ where: { id: dRun } });
      await db.agent.deleteMany({ where: { id: dAgent } });
    }
  });

  it("copies only a refusal's well-formed amounts, model and turn, and records nothing for a malformed one", async () => {
    const fRun = `forged-run-${suffix}`;
    const fSession = `forged-session-${suffix}`;
    const fAgent = `forged-agent-${suffix}`;
    const ledger = new PrismaProxyLedger(db);
    const store = new PrismaContainerExecutionStore(db);
    await db.agent.create({
      data: { id: fAgent, name: fAgent, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
    });
    await db.run.create({ data: { id: fRun, agentId: fAgent, executionManaged: true } });
    try {
      await db.codingRun.create({
        data: {
          runId: fRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${fRun}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 1,
        },
      });
      await ledger.createSession({
        id: fSession,
        runId: fRun,
        capabilityHash: `forged-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: ["gpt-5.6-luna"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        registryTokenHash: `forged-registry-${suffix}`,
      });
      const amounts = {
        budgetUsd: 1,
        spentUsd: 0.5,
        heldReservedUsd: 0.1,
        heldUncertainUsd: 0,
        refusedHoldUsd: 0.6,
        model: "gpt-5.6-luna",
        turn: 3,
      };
      const forge = (refusal: unknown) =>
        db.$executeRaw`UPDATE "CodingProxySession" SET "budgetRefusal" = ${JSON.stringify(refusal)}::jsonb WHERE "id" = ${fSession}`;

      await forge({ ...amounts, refusedHoldUsd: undefined, groupName: "forged" });
      await store.recordBudgetRefusal(fRun, fSession);
      await forge({ ...amounts, model: "<script>" });
      await store.recordBudgetRefusal(fRun, fSession);
      expect(await db.runBudgetEvent.count({ where: { runId: fRun } })).toBe(0);

      await forge({ ...amounts, source: "dispatch", groupName: "forged", leadAgentName: "forged", note: "x" });
      await store.recordBudgetRefusal(fRun, fSession);
      const events = await db.runBudgetEvent.findMany({ where: { runId: fRun } });
      expect(events.map((e) => e.details)).toEqual([{ ...amounts, source: "proxy" }]);
    } finally {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${fSession}`;
      await db.codingRun.deleteMany({ where: { runId: fRun } });
      await db.run.deleteMany({ where: { id: fRun } });
      await db.agent.deleteMany({ where: { id: fAgent } });
    }
  });

  describe("model terms", () => {
    const tAgent = `terms-agent-${suffix}`;
    const tRun = `terms-run-${suffix}`;
    const tSession = `terms-session-${suffix}`;
    const pRun = `terms-proxy-run-${suffix}`;

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "runId" IN (${tRun}, ${pRun})`;
      await db.codingRun.deleteMany({ where: { runId: { in: [tRun, pRun] } } });
      await db.run.deleteMany({ where: { id: { in: [tRun, pRun] } } });
      await db.agent.deleteMany({ where: { id: tAgent } });
    });

    const corruptions: Array<[string, string | null, string | null]> = [
      ["a version with an unreadable entry", "v1", JSON.stringify({ modelId: "gpt-5.6-luna", inputPerMTok: -1 })],
      ["a version with no entry", "v1", null],
      ["an entry with no version", null, JSON.stringify(entryOf(shippedCatalog().require("gpt-5.6-luna")))],
    ];

    it("round-trips a session's catalog entry and its version", async () => {
      const entry = { ...entryOf(shippedCatalog().require("gpt-5.6-luna")), outputPerMTok: 99 };
      await db.agent.create({
        data: { id: tAgent, name: tAgent, systemPrompt: "x", model: entry.modelId, budgetUsd: 1 },
      });
      await db.run.create({ data: { id: tRun, agentId: tAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: tRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${tRun}`,
          provider: "codex",
          model: entry.modelId,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 1,
        },
      });
      const ledger = new PrismaProxyLedger(db);
      await ledger.createSession({
        id: tSession,
        runId: tRun,
        capabilityHash: `terms-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [entry.modelId],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        registryTokenHash: `terms-registry-hash-${suffix}`,
        terms: { version: "2026-10-04T00:00:00.000Z", entry },
      });
      const session = await new PrismaProxyLedger(db).findSessionByCapabilityHash(`terms-hash-${suffix}`);
      expect(session?.terms).toEqual({ version: "2026-10-04T00:00:00.000Z", entry });
    });

    it.each(corruptions)("refuses to read a session with %s", async (_label, version, entry) => {
      await db.$executeRaw`
        UPDATE "CodingProxySession" SET "pricingVersion" = ${version}, "catalogEntry" = ${entry}::jsonb
        WHERE "id" = ${tSession}
      `;
      await expect(new PrismaProxyLedger(db).findSessionByCapabilityHash(`terms-hash-${suffix}`)).rejects.toThrow(
        "invalid_proxy_session_terms",
      );
    });

    it("refuses to store unreadable terms", async () => {
      const entry = entryOf(shippedCatalog().require("gpt-5.6-luna"));
      await expect(
        new PrismaProxyLedger(db).createSession({
          id: `terms-bad-${suffix}`,
          runId: tRun,
          capabilityHash: `terms-bad-hash-${suffix}`,
          credentialRef: "openai/test",
          protocol: "openai-responses",
          allowedModels: [entry.modelId],
          deadlineAt: new Date(Date.now() + 60_000),
          budgetUsd: 1,
          registryTokenHash: `terms-bad-registry-${suffix}`,
          terms: { version: "", entry },
        }),
      ).rejects.toThrow("invalid_proxy_session_terms");
    });

    it("refuses, without billing or calling upstream, a request on a session whose stored terms were corrupted", async () => {
      const entry = entryOf(shippedCatalog().require("gpt-5.6-luna"));
      await db.run.create({ data: { id: pRun, agentId: tAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: pRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${pRun}`,
          provider: "codex",
          model: entry.modelId,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 1,
        },
      });
      const fetch = async () => {
        throw new Error("upstream must not be called");
      };
      const proxy = new CodingProxy({
        ledger: new PrismaProxyLedger(db),
        credentials: { resolve: async () => "secret" },
        fetch,
      });
      const session = await proxy.createSession({
        runId: pRun,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [entry.modelId],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        terms: { version: "v1", entry },
      });
      await db.$executeRaw`UPDATE "CodingProxySession" SET "catalogEntry" = '{"bad":true}'::jsonb WHERE "id" = ${session.id}`;
      const sink: ProxyResponseSink = { start() {}, write() {}, end() {}, destroy() {} };
      await expect(
        proxy.execute(
          {
            bearer: session.capability,
            protocol: "openai-responses",
            rawBody: JSON.stringify({ model: entry.modelId, input: "hi", max_output_tokens: 10, stream: false }),
            requestKey: "corrupt-terms",
          },
          sink,
        ),
      ).rejects.toThrow("invalid_proxy_session_terms");
      const requests = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS "count" FROM "CodingProxyRequest" WHERE "sessionId" = ${session.id}
      `;
      expect(Number(requests[0].count)).toBe(0);
    });
  });

  describe("per-model usage (RunModelUsage)", () => {
    const uAgent = `usage-agent-${suffix}`;
    const uRun = `usage-run-${suffix}`;
    const uSession = `usage-session-${suffix}`;
    const modelA = "model-a";
    const modelB = "model-b";
    const ledger = new PrismaProxyLedger(db);
    const u = (inputTokens: number, cachedInputTokens: number, cacheWriteTokens: number, outputTokens: number) => ({
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens: 0,
    });
    const reserveOn = async (key: string, model: string) => {
      const result = await ledger.reserve({
        id: `${key}-${suffix}`,
        sessionId: uSession,
        requestKey: key,
        requestFingerprint: `fingerprint-${key}`,
        model,
        reservationUsd: 0.001,
        pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
        now: new Date(),
      });
      if (result.outcome !== "reserved") throw new Error(`unexpected ${result.outcome}`);
      return result.request.id;
    };

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${uSession}`;
      await db.runModelUsage.deleteMany({ where: { runId: uRun } });
      await db.codingRun.deleteMany({ where: { runId: uRun } });
      await db.run.deleteMany({ where: { id: uRun } });
      await db.agent.deleteMany({ where: { id: uAgent } });
    });

    it("recomputes per-model usage on each completion, by priced token kind", async () => {
      await db.agent.create({
        data: { id: uAgent, name: uAgent, systemPrompt: "x", model: modelA, budgetUsd: 1 },
      });
      await db.run.create({ data: { id: uRun, agentId: uAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: uRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${uRun}`,
          provider: "codex",
          model: modelA,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 1,
        },
      });
      await ledger.createSession({
        id: uSession,
        runId: uRun,
        capabilityHash: `usage-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [modelA, modelB],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        registryTokenHash: `usage-registry-hash-${suffix}`,
      });
      await ledger.complete(await reserveOn("a1", modelA), u(1000, 800, 100, 50), 0.01, 200);
      await ledger.complete(await reserveOn("a2", modelA), u(500, 400, 0, 20), 0.005, 200);
      await ledger.complete(await reserveOn("b1", modelB), u(200, 0, 0, 10), 0.002, 200);

      const rows = await db.runModelUsage.findMany({ where: { runId: uRun }, orderBy: { model: "asc" } });
      expect(rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) }))).toEqual([
        {
          runId: uRun,
          model: modelA,
          freshInputTokens: 300,
          cachedInputTokens: 1200,
          cacheWriteTokens: 100,
          outputTokens: 70,
          costUsd: expect.closeTo(0.015, 10),
        },
        {
          runId: uRun,
          model: modelB,
          freshInputTokens: 200,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 10,
          costUsd: expect.closeTo(0.002, 10),
        },
      ]);
      const run = await db.run.findUniqueOrThrow({ where: { id: uRun } });
      const sum = rows.reduce((total, r) => total + Number(r.costUsd), 0);
      expect(Number(run.costUsd)).toBeCloseTo(sum, 6);
    });

    it("a repeated completion does not double the per-model row", async () => {
      const before = await db.runModelUsage.findUniqueOrThrow({
        where: { runId_model: { runId: uRun, model: modelA } },
      });
      await new PrismaProxyLedger(db).complete(`a1-${suffix}`, u(1000, 800, 100, 50), 0.01, 200);
      const after = await db.runModelUsage.findUniqueOrThrow({
        where: { runId_model: { runId: uRun, model: modelA } },
      });
      expect(after).toEqual(before);
      expect(after.outputTokens).toBe(70);
    });

    it("never fails a completion when the per-model write fails", async () => {
      // A trigger that rejects only this test's model makes the RunModelUsage write fail (like a missing grant).
      const failModel = `fail-model-${suffix}`;
      const fn = `fail_rmu_${suffix.replaceAll("-", "_")}`;
      await db.$executeRawUnsafe(
        `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."model" = '${failModel}' THEN RAISE EXCEPTION 'denied'; END IF; RETURN NEW; END $$`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER "${fn}" BEFORE INSERT OR UPDATE ON "RunModelUsage" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
      );
      try {
        const before = await db.run.findUniqueOrThrow({ where: { id: uRun } });
        const id = await reserveOn("f1", failModel);
        const done = await ledger.complete(id, u(100, 0, 0, 5), 0.001, 200);
        expect(done.status).toBe("completed");
        const run = await db.run.findUniqueOrThrow({ where: { id: uRun } });
        expect(run.tokensIn).toBe(before.tokensIn + 100);
        expect(Number(run.costUsd)).toBeCloseTo(Number(before.costUsd) + 0.001, 6);
        expect(await db.runModelUsage.count({ where: { runId: uRun, model: failModel } })).toBe(0);
        // Rolling back to the savepoint leaves the rows already recorded for the other models intact.
        const rows = await db.runModelUsage.count({ where: { runId: uRun } });
        expect(rows).toBe(2);
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${fn}" ON "RunModelUsage"`);
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`);
      }
    });
  });

  describe("interrupted replies settled at an estimate", () => {
    const eAgent = `estimate-agent-${suffix}`;
    const eRun = `estimate-run-${suffix}`;
    const eSession = `estimate-session-${suffix}`;
    const model = "estimate-model";
    const otherModel = "estimate-other-model";
    const ledger = new PrismaProxyLedger(db);
    const u = (inputTokens: number, cachedInputTokens: number, cacheWriteTokens: number, outputTokens: number) => ({
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens: 0,
    });
    const reserveOn = (key: string, reservationUsd: number, onModel = model) =>
      ledger.reserve({
        id: `${key}-${suffix}`,
        sessionId: eSession,
        requestKey: key,
        requestFingerprint: `fingerprint-${key}`,
        model: onModel,
        reservationUsd,
        pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
        now: new Date(),
      });
    const reserved = async (key: string, reservationUsd: number, onModel = model) => {
      const result = await reserveOn(key, reservationUsd, onModel);
      if (result.outcome !== "reserved") throw new Error(`unexpected ${result.outcome}`);
      return result.request.id;
    };

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${eSession}`;
      await db.runModelUsage.deleteMany({ where: { runId: eRun } });
      await db.codingRun.deleteMany({ where: { runId: eRun } });
      await db.run.deleteMany({ where: { id: eRun } });
      await db.agent.deleteMany({ where: { id: eAgent } });
    });

    it("counts an estimated uncertain request at its estimate, in the ledger and the run's totals", async () => {
      await db.agent.create({ data: { id: eAgent, name: eAgent, systemPrompt: "x", model, budgetUsd: 1 } });
      await db.run.create({ data: { id: eRun, agentId: eAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: eRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${eRun}`,
          provider: "codex",
          model,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 0.001,
        },
      });
      await ledger.createSession({
        id: eSession,
        runId: eRun,
        capabilityHash: `estimate-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [model, otherModel],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 0.001,
        registryTokenHash: `estimate-registry-hash-${suffix}`,
      });

      const cut = await reserved("cut", 0.0001);
      await ledger.markUncertain(cut, 200, { usage: u(120, 20, 10, 5), costUsd: 0.00003 });
      expect(await ledger.getRequest(cut)).toMatchObject({
        status: "uncertain",
        costEstimated: true,
        actualCostUsd: 0.00003,
        upstreamStatus: 200,
        usage: u(120, 20, 10, 5),
      });
      // A second mark (the request is no longer reserved) changes nothing.
      await ledger.markUncertain(cut, 502, { usage: u(1, 0, 0, 1), costUsd: 0.00009 });
      expect(await ledger.getRequest(cut)).toMatchObject({ actualCostUsd: 0.00003, upstreamStatus: 200 });

      const run = await db.run.findUniqueOrThrow({ where: { id: eRun } });
      expect(Number(run.costUsd)).toBeCloseTo(0.00003, 10);
      expect(run).toMatchObject({ turns: 1, tokensIn: 120, tokensOut: 5 });
      const usage = await db.runModelUsage.findUniqueOrThrow({ where: { runId_model: { runId: eRun, model } } });
      expect(usage).toMatchObject({
        freshInputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteTokens: 10,
        outputTokens: 5,
      });
      expect(Number(usage.costUsd)).toBeCloseTo(0.00003, 10);

      // Fits only because the estimate (0.00003), not the hold (0.0001), is counted: 0.00099 < 0.001.
      const big = await reserveOn("big", 0.00096);
      expect(big.outcome).toBe("reserved");
      if (big.outcome === "reserved") await ledger.release(big.request.id, 500);
    });

    it("keeps the full hold of an uncertain request without an estimate", async () => {
      const held = await reserved("held", 0.0001);
      await ledger.markUncertain(held, 502);
      const request = await ledger.getRequest(held);
      expect(request).toMatchObject({ status: "uncertain", costEstimated: false });
      expect(request?.actualCostUsd).toBeUndefined();
      expect(request?.usage).toBeUndefined();
      const run = await db.run.findUniqueOrThrow({ where: { id: eRun } });
      expect(run.turns).toBe(1);
      // Held: 0.00003 (estimate) + 0.0001 (hold) + 0.00087 = 0.001 — refused.
      expect((await reserveOn("over", 0.00087)).outcome).toBe("budget_exhausted");
    });

    it("hints the median output of the model's completed replies", async () => {
      await ledger.complete(await reserved("c1", 0.0001), u(100, 20, 5, 8), 0.00001, 200);
      await ledger.complete(await reserved("c2", 0.0001), u(200, 0, 0, 30), 0.00002, 200);
      await ledger.complete(await reserved("c3", 0.0001, otherModel), u(300, 0, 0, 12), 0.00001, 200);
      // Another model's replies don't count.
      expect(await ledger.settlementHints(eSession, model)).toEqual({ medianOutputTokens: 8 });
      expect(await ledger.settlementHints(eSession, otherModel)).toEqual({ medianOutputTokens: 12 });
      expect(await ledger.settlementHints(eSession, "no-such-model")).toEqual({});
      expect(await ledger.settlementHints(`missing-${suffix}`, model)).toEqual({});
    });
  });

  describe("previous reply for cache-aware holds", () => {
    const pAgent = `prev-agent-${suffix}`;
    const pRun = `prev-run-${suffix}`;
    const pSession = `prev-session-${suffix}`;
    const model = "prev-model";
    const ledger = new PrismaProxyLedger(db);
    const usage = { inputTokens: 100, outputTokens: 5, cachedInputTokens: 90, cacheWriteTokens: 0, reasoningTokens: 0 };
    const reserveIn = async (key: string, extra: Partial<Parameters<typeof ledger.reserve>[0]> = {}) => {
      const result = await ledger.reserve({
        id: `prev-${key}-${suffix}`,
        sessionId: pSession,
        requestKey: key,
        requestFingerprint: `fingerprint-${key}`,
        model,
        reservationUsd: 0.0001,
        pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
        now: new Date(),
        ...extra,
      });
      if (result.outcome !== "reserved") throw new Error(`unexpected ${result.outcome}`);
      return result.request.id;
    };

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${pSession}`;
      await db.runModelUsage.deleteMany({ where: { runId: pRun } });
      await db.codingRun.deleteMany({ where: { runId: pRun } });
      await db.run.deleteMany({ where: { id: pRun } });
      await db.agent.deleteMany({ where: { id: pAgent } });
    });

    it("stores the request size, ceiling, basis and conversation, and returns the finished reply", async () => {
      await db.agent.create({ data: { id: pAgent, name: pAgent, systemPrompt: "x", model, budgetUsd: 1 } });
      await db.run.create({ data: { id: pRun, agentId: pAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: pRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${pRun}`,
          provider: "codex",
          model,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 0.001,
        },
      });
      await ledger.createSession({
        id: pSession,
        runId: pRun,
        capabilityHash: `prev-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [model],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        registryTokenHash: `prev-registry-hash-${suffix}`,
      });

      const a = await reserveIn("a", {
        requestBytes: 1000,
        ceilingUsd: 0.5,
        reservationBasis: "full",
        conversationKey: "k1",
      });
      expect(await ledger.getRequest(a)).toMatchObject({
        requestBytes: 1000,
        ceilingUsd: 0.5,
        reservationBasis: "full",
        conversationKey: "k1",
      });
      await ledger.complete(a, usage, 0.00001, 200);
      const reply = await ledger.previousReply(pSession, "k1");
      expect(reply).toMatchObject({
        model,
        status: "completed",
        costEstimated: false,
        usage,
        requestBytes: 1000,
      });
      expect(Math.abs(Date.now() - reply!.startedAt.getTime())).toBeLessThan(60_000);
    });

    it("returns an interrupted request settled at an estimate as the latest", async () => {
      const b = await reserveIn("b", {
        requestBytes: 2000,
        ceilingUsd: 0.5,
        reservationBasis: "cached",
        conversationKey: "k1",
      });
      await ledger.markUncertain(b, 200, { usage, costUsd: 0.00002 });
      expect(await ledger.previousReply(pSession, "k1")).toMatchObject({
        status: "uncertain",
        costEstimated: true,
        requestBytes: 2000,
      });
    });

    it("has no previous reply for an unknown conversation", async () => {
      expect(await ledger.previousReply(pSession, "other")).toBeNull();
    });
  });
  describe("request leases", () => {
    const lAgent = `lease-agent-${suffix}`;
    const lRun = `lease-run-${suffix}`;
    const lSession = `lease-session-${suffix}`;
    const model = "lease-model";
    const LEASE_MS = 30_000;
    const ledger = new PrismaProxyLedger(db);
    const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const reserveResult = (key: string, extra: Partial<Parameters<typeof ledger.reserve>[0]>) =>
      ledger.reserve({
        id: `lease-${key}-${suffix}`,
        sessionId: lSession,
        requestKey: key,
        requestFingerprint: `fingerprint-${key}`,
        model,
        reservationUsd: 0.0001,
        maxOutputTokens: 100,
        pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
        now: new Date(),
        ...extra,
      });
    const reserveLeased = async (
      key: string,
      extra: Partial<Parameters<typeof ledger.reserve>[0]> = { ownerId: `owner-${suffix}`, leaseMs: LEASE_MS },
    ) => {
      const result = await reserveResult(key, extra);
      if (result.outcome !== "reserved") throw new Error(`unexpected ${result.outcome}`);
      return result.request.id;
    };
    /** Moves a row's lease into the past, as if its owner had stopped renewing it. */
    const expire = (id: string, interval = "1 minute") =>
      db.$executeRaw`UPDATE "CodingProxyRequest" SET "leaseUntil" = CURRENT_TIMESTAMP - ${interval}::interval WHERE "id" = ${id}`;
    const expiredHere = async () =>
      (await ledger.expiredLeases(1000)).filter((item) => item.request.sessionId === lSession);

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${lSession}`;
      await db.runModelUsage.deleteMany({ where: { runId: lRun } });
      await db.codingRun.deleteMany({ where: { runId: lRun } });
      await db.run.deleteMany({ where: { id: lRun } });
      await db.agent.deleteMany({ where: { id: lAgent } });
    });

    it("leases a request to its owner from the database clock, and leaves an unowned one unleased", async () => {
      await db.agent.create({ data: { id: lAgent, name: lAgent, systemPrompt: "x", model, budgetUsd: 1 } });
      await db.run.create({ data: { id: lRun, agentId: lAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: lRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${lRun}`,
          provider: "codex",
          model,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 0.001,
        },
      });
      await ledger.createSession({
        id: lSession,
        runId: lRun,
        capabilityHash: `lease-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [model],
        deadlineAt: new Date(Date.now() + 600_000),
        budgetUsd: 0.001,
        registryTokenHash: `lease-registry-hash-${suffix}`,
      });

      const before = Date.now();
      const leased = await reserveLeased("leased");
      const request = await ledger.getRequest(leased);
      expect(request).toMatchObject({ status: "reserved", ownerId: `owner-${suffix}`, maxOutputTokens: 100 });
      // The database's clock, so allow for a skew between it and this process.
      expect(Math.abs(request!.leaseUntil!.getTime() - (before + LEASE_MS))).toBeLessThan(5_000);

      const unowned = await reserveLeased("unowned", { leaseMs: LEASE_MS });
      const unleased = await reserveLeased("unleased", {});
      for (const id of [unowned, unleased]) expect((await ledger.getRequest(id))?.leaseUntil).toBeNull();
      await ledger.release(unowned, 500);
      await ledger.release(unleased, 500);
      await ledger.release(leased, 500);
    });

    it("renews only the owner's own reserved requests", async () => {
      const mine = await reserveLeased("renew-mine");
      const theirs = await reserveLeased("renew-theirs", { ownerId: `other-${suffix}`, leaseMs: LEASE_MS });
      const settled = await reserveLeased("renew-settled");
      await ledger.complete(settled, usage, 0.00001, 200);
      await Promise.all([mine, theirs].map((id) => expire(id)));

      const renewal = await ledger.renewLeases(
        `owner-${suffix}`,
        [mine, theirs, settled, `missing-${suffix}`],
        LEASE_MS,
      );
      expect(renewal).toEqual({ renewed: [mine], cancelled: [] });

      expect((await ledger.getRequest(mine))!.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
      expect((await ledger.getRequest(theirs))!.leaseUntil!.getTime()).toBeLessThan(Date.now());
      expect((await ledger.getRequest(settled))?.leaseUntil).toBeNull();
      await ledger.renewLeases(`owner-${suffix}`, [], LEASE_MS);
      await ledger.release(mine, 500);
      await ledger.release(theirs, 500);
      expect(await ledger.renewLeases(`owner-${suffix}`, [], LEASE_MS)).toEqual({ renewed: [], cancelled: [] });
    });

    it("tells an owner whose request another process swept that it no longer holds it", async () => {
      const ownerA = `owner-a-${suffix}`;
      const ownerB = `owner-b-${suffix}`;
      const a = await reserveLeased("fence-a", { ownerId: ownerA, leaseMs: LEASE_MS });
      const b = await reserveLeased("fence-b", { ownerId: ownerB, leaseMs: LEASE_MS });

      // A stalls past its lease; B's process sweeps the request. B's own request is untouched.
      await expire(a);
      expect(await ledger.settleExpired(a)).toBe(true);

      // A is alive and heartbeats: it is told it holds nothing. B is told it still holds its own.
      expect(await ledger.renewLeases(ownerA, [a], LEASE_MS)).toEqual({ renewed: [], cancelled: [] });
      expect(await ledger.renewLeases(ownerB, [a, b], LEASE_MS)).toEqual({ renewed: [b], cancelled: [] });
      expect(await ledger.getRequest(a)).toMatchObject({ status: "uncertain", leaseUntil: null });
      await ledger.release(b, 500);
      // Settled without an estimate it keeps its full hold, which the session's small budget cannot spare.
      await db.$executeRaw`DELETE FROM "CodingProxyRequest" WHERE "id" = ${a}`;
    });

    it("lets an owner whose lease ran out but was not yet swept renew it and keep the request", async () => {
      const ownerA = `owner-a-${suffix}`;
      const a = await reserveLeased("fence-late", { ownerId: ownerA, leaseMs: LEASE_MS });
      await expire(a);
      expect(await ledger.renewLeases(ownerA, [a], LEASE_MS)).toEqual({ renewed: [a], cancelled: [] });
      expect(await ledger.settleExpired(a)).toBe(false);
      await ledger.release(a, 500);
    });

    it("lists the renewed requests whose session was cancelled", async () => {
      const mine = await reserveLeased("fence-cancel");
      await ledger.cancelSession(lSession);
      try {
        expect(await ledger.renewLeases(`owner-${suffix}`, [mine], LEASE_MS)).toEqual({
          renewed: [mine],
          cancelled: [mine],
        });
      } finally {
        // The other tests share this session.
        await db.$executeRaw`UPDATE "CodingProxySession" SET "status" = 'active' WHERE "id" = ${lSession}`;
      }
      await ledger.release(mine, 500);
    });

    it("lists only reserved requests whose lease has passed, with their run, oldest lease first", async () => {
      const live = await reserveLeased("list-live");
      const noLease = await reserveLeased("list-no-lease", {});
      const dead = await reserveLeased("list-dead");
      const older = await reserveLeased("list-older");
      const done = await reserveLeased("list-done");
      await ledger.complete(done, usage, 0.00001, 200);
      await expire(dead);
      await expire(older, "2 minutes");
      await expire(done);
      await expire(noLease);
      await db.$executeRaw`UPDATE "CodingProxyRequest" SET "leaseUntil" = NULL WHERE "id" = ${noLease}`;

      const expired = await expiredHere();
      expect(expired.map((item) => item.request.id)).toEqual([older, dead]);
      expect(expired[0]).toMatchObject({ runId: lRun, request: { status: "reserved", maxOutputTokens: 100 } });
      expect(Math.abs(expired[0].createdAt.getTime() - Date.now())).toBeLessThan(60_000);
      expect((await ledger.expiredLeases(1)).length).toBe(1);
      for (const id of [live, noLease, dead, older]) await ledger.release(id, 500);
    });

    it("settles an expired request at an estimate, into the run's totals and out of the budget's holds", async () => {
      // The session budget is 0.001. A hold of 0.0009 fits beside nothing else held.
      const dead = await reserveLeased("swept", {
        ownerId: `owner-${suffix}`,
        leaseMs: LEASE_MS,
        reservationUsd: 0.0009,
      });
      await expire(dead);
      expect((await reserveResult("blocked", { reservationUsd: 0.0005 })).outcome).toBe("budget_exhausted");

      const estimate = { usage: { ...usage, outputTokens: 3 }, costUsd: 0.00002 };
      expect(await ledger.settleExpired(dead, estimate)).toBe(true);

      expect(await ledger.getRequest(dead)).toMatchObject({
        status: "uncertain",
        costEstimated: true,
        actualCostUsd: 0.00002,
        leaseUntil: null,
        ownerId: `owner-${suffix}`,
        usage: estimate.usage,
      });
      const run = await db.run.findUniqueOrThrow({ where: { id: lRun } });
      expect(Number(run.costUsd)).toBeGreaterThan(0);
      expect(run.turns).toBeGreaterThanOrEqual(1);
      // The hold is gone, so the request that did not fit before now does.
      const next = await reserveResult("after-sweep", { reservationUsd: 0.0005 });
      expect(next.outcome).toBe("reserved");
      if (next.outcome === "reserved") await ledger.release(next.request.id, 500);
    });

    it("settles an expired request once, and only while it is still reserved and expired", async () => {
      const renewed = await reserveLeased("guard-renewed");
      await expire(renewed);
      await ledger.renewLeases(`owner-${suffix}`, [renewed], LEASE_MS);
      expect(await ledger.settleExpired(renewed, { usage, costUsd: 0.00001 })).toBe(false);
      expect((await ledger.getRequest(renewed))?.status).toBe("reserved");

      const finished = await reserveLeased("guard-finished");
      await expire(finished);
      await ledger.complete(finished, usage, 0.00001, 200);
      expect(await ledger.settleExpired(finished, { usage, costUsd: 0.00009 })).toBe(false);
      expect(await ledger.getRequest(finished)).toMatchObject({ status: "completed", actualCostUsd: 0.00001 });

      const unleased = await reserveLeased("guard-unleased", {});
      expect(await ledger.settleExpired(unleased)).toBe(false);
      expect(await ledger.settleExpired(`missing-${suffix}`)).toBe(false);

      const raced = await reserveLeased("guard-raced");
      await expire(raced);
      const results = await Promise.all([
        ledger.settleExpired(raced, { usage, costUsd: 0.00001 }),
        new PrismaProxyLedger(db).settleExpired(raced, { usage, costUsd: 0.00001 }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await ledger.release(renewed, 500);
      await ledger.release(unleased, 500);
    });

    it("settles an expired request without an estimate by keeping its hold", async () => {
      const dead = await reserveLeased("no-estimate");
      await expire(dead);
      expect(await ledger.settleExpired(dead)).toBe(true);
      const request = await ledger.getRequest(dead);
      expect(request).toMatchObject({ status: "uncertain", costEstimated: false, leaseUntil: null });
      expect(request?.actualCostUsd).toBeUndefined();
    });

    it("lets a swept request finish at its real cost", async () => {
      const dead = await reserveLeased("late-finish");
      await expire(dead);
      await ledger.settleExpired(dead, { usage, costUsd: 0.00002 });
      const done = await ledger.complete(dead, { ...usage, outputTokens: 40 }, 0.00007, 200);
      expect(done).toMatchObject({
        status: "completed",
        costEstimated: false,
        actualCostUsd: 0.00007,
        leaseUntil: null,
      });
    });

    it("clears the lease, and keeps the owner, when a request settles any other way", async () => {
      const completed = await reserveLeased("clean-completed");
      const released = await reserveLeased("clean-released");
      const uncertain = await reserveLeased("clean-uncertain");
      await ledger.complete(completed, usage, 0.00001, 200);
      await ledger.release(released, 500);
      await ledger.markUncertain(uncertain, 502);
      for (const id of [completed, released, uncertain]) {
        expect(await ledger.getRequest(id)).toMatchObject({ leaseUntil: null, ownerId: `owner-${suffix}` });
      }
    });
  });

  describe("stopping a run from another process", () => {
    const sAgent = `stop-agent-${suffix}`;
    const sRun = `stop-run-${suffix}`;
    const entry = entryOf(shippedCatalog().require("gpt-5.6-luna"));

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "runId" = ${sRun}`;
      await db.runModelUsage.deleteMany({ where: { runId: sRun } });
      await db.codingRun.deleteMany({ where: { runId: sRun } });
      await db.run.deleteMany({ where: { id: sRun } });
      await db.agent.deleteMany({ where: { id: sAgent } });
    });

    it("aborts the stream held by one proxy when another proxy cancels the session, at the next heartbeat", async () => {
      await db.agent.create({
        data: { id: sAgent, name: sAgent, systemPrompt: "x", model: entry.modelId, budgetUsd: 1 },
      });
      await db.run.create({ data: { id: sRun, agentId: sAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: sRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${sRun}`,
          provider: "codex",
          model: entry.modelId,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 1,
        },
      });
      // The relay's upstream stays open until the proxy aborts it.
      let upstreamAborted = false;
      const holdOpen: typeof globalThis.fetch = async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => {
                upstreamAborted = true;
                controller.error(new Error("aborted"));
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const instance = (ownerId: string) =>
        new CodingProxy({
          ledger: new PrismaProxyLedger(db),
          credentials: { resolve: async () => "secret" },
          fetch: holdOpen,
          leaseMs: 30_000,
          ownerId,
        });
      const relay = instance(`relay-${suffix}`);
      // The control plane's own instance: same database, no stream, so it cannot abort anything itself.
      const controlPlane = instance(`control-plane-${suffix}`);
      const session = await relay.createSession({
        runId: sRun,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [entry.modelId],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        terms: { version: "v1", entry },
      });
      const sink: ProxyResponseSink = { start() {}, write() {}, end() {}, destroy() {} };
      const pending = relay
        .execute(
          {
            bearer: session.capability,
            protocol: "openai-responses",
            rawBody: JSON.stringify({ model: entry.modelId, input: "hi", max_output_tokens: 10, stream: true }),
            requestKey: "held-open",
          },
          sink,
        )
        .catch((error: unknown) => error);
      const requestRow = async () => {
        const rows = await db.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT "id", "status" FROM "CodingProxyRequest" WHERE "sessionId" = ${session.id}
        `;
        return rows[0];
      };
      await vi.waitFor(async () => expect((await requestRow())?.status).toBe("reserved"), { timeout: 5_000 });

      // A heartbeat before the stop leaves a live request alone.
      await relay.renewOwnLeases();
      expect(upstreamAborted).toBe(false);

      // The stop lands through the other instance; the relay is not told directly.
      await controlPlane.cancelSession(session.id);
      expect(upstreamAborted).toBe(false);

      await relay.renewOwnLeases();
      expect(await pending).toMatchObject({ status: 502 });
      expect(upstreamAborted).toBe(true);
      const row = await requestRow();
      expect(row).toMatchObject({ status: "uncertain" });
      expect(await new PrismaProxyLedger(db).getRequest(row.id)).toMatchObject({
        status: "uncertain",
        leaseUntil: null,
      });
    });
  });

  describe("request attempts", () => {
    const aAgent = `attempt-agent-${suffix}`;
    const aRun = `attempt-run-${suffix}`;
    const aSession = `attempt-session-${suffix}`;
    const model = "attempt-model";
    const LEASE_MS = 30_000;
    const ledger = new PrismaProxyLedger(db);
    const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const estimate = { usage, costUsd: 0.00002 };
    let counter = 0;
    /** One try of request key `key` (a fixed body): `id` names the row, `extra` its lease, cap or takeover. */
    const tryKey = (key: string, extra: Partial<Parameters<typeof ledger.reserve>[0]> = {}) =>
      ledger.reserve({
        id: `attempt-${key}-${++counter}-${suffix}`,
        sessionId: aSession,
        requestKey: key,
        requestFingerprint: `fingerprint-${key}`,
        model,
        reservationUsd: 0.0001,
        maxOutputTokens: 100,
        pricing: { version: "test", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 },
        now: new Date(),
        ownerId: `owner-${suffix}`,
        leaseMs: LEASE_MS,
        maxAttempts: 3,
        ...extra,
      });
    const reserved = async (key: string, extra: Partial<Parameters<typeof ledger.reserve>[0]> = {}) => {
      const result = await tryKey(key, extra);
      if (result.outcome !== "reserved") throw new Error(`unexpected ${result.outcome}`);
      return result;
    };
    const expire = (id: string) =>
      db.$executeRaw`UPDATE "CodingProxyRequest" SET "leaseUntil" = CURRENT_TIMESTAMP - interval '1 minute' WHERE "id" = ${id}`;
    const attemptsOf = (key: string) =>
      db.$queryRaw<{ id: string; attempt: number; status: string }[]>`
        SELECT "id", "attempt", "status" FROM "CodingProxyRequest"
        WHERE "sessionId" = ${aSession} AND "requestKey" = ${key} ORDER BY "attempt"`;

    beforeAll(async () => {
      await db.agent.create({ data: { id: aAgent, name: aAgent, systemPrompt: "x", model, budgetUsd: 1 } });
      await db.run.create({ data: { id: aRun, agentId: aAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: aRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${aRun}`,
          provider: "codex",
          model,
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 0.001,
        },
      });
      await ledger.createSession({
        id: aSession,
        runId: aRun,
        capabilityHash: `attempt-hash-${suffix}`,
        credentialRef: "openai/test",
        protocol: "openai-responses",
        allowedModels: [model],
        deadlineAt: new Date(Date.now() + 600_000),
        budgetUsd: 0.01,
        registryTokenHash: `attempt-registry-hash-${suffix}`,
      });
    });

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${aSession}`;
      await db.runModelUsage.deleteMany({ where: { runId: aRun } });
      await db.codingRun.deleteMany({ where: { runId: aRun } });
      await db.run.deleteMany({ where: { id: aRun } });
      await db.agent.deleteMany({ where: { id: aAgent } });
    });

    it("answers a retry inside the lease as in progress, with the lease's remaining time", async () => {
      const first = await reserved("in-lease");
      const retry = await tryKey("in-lease");
      expect(retry).toMatchObject({ outcome: "in_progress", request: { id: first.request.id } });
      const remaining = (retry as { retryAfterMs: number }).retryAfterMs;
      expect(remaining).toBeGreaterThan(LEASE_MS - 10_000);
      expect(remaining).toBeLessThanOrEqual(LEASE_MS);
    });

    it("takes an orphan over in one transaction: settles it at the estimate and reserves attempt 2", async () => {
      const first = await reserved("takeover");
      await expire(first.request.id);
      const orphaned = await tryKey("takeover");
      expect(orphaned).toMatchObject({
        outcome: "orphaned",
        orphan: { runId: aRun, request: { id: first.request.id } },
      });
      expect((await ledger.getRequest(first.request.id))?.status).toBe("reserved");

      const second = await reserved("takeover", { takeover: { requestId: first.request.id, estimate } });
      expect(second).toMatchObject({ request: { attempt: 2 }, tookOver: { requestId: first.request.id } });
      expect(await ledger.getRequest(first.request.id)).toMatchObject({
        status: "uncertain",
        costEstimated: true,
        actualCostUsd: 0.00002,
        leaseUntil: null,
        attempt: 1,
      });
      expect((await ledger.getRequest(first.request.id))?.orphanedAt).toBeInstanceOf(Date);
      expect((await attemptsOf("takeover")).map((row) => [row.attempt, row.status])).toEqual([
        [1, "uncertain"],
        [2, "reserved"],
      ]);
    });

    it("takes a request the sweep settled over, and a late finish of the old owner still corrects its row", async () => {
      const first = await reserved("swept");
      await expire(first.request.id);
      expect(await ledger.settleExpired(first.request.id, estimate)).toBe(true);
      const second = await reserved("swept");
      expect(second).toMatchObject({ request: { attempt: 2 }, tookOver: { requestId: first.request.id } });
      expect(await ledger.complete(first.request.id, usage, 0.00007, 200)).toMatchObject({
        status: "completed",
        actualCostUsd: 0.00007,
        attempt: 1,
      });
    });

    it("lets two concurrent takeovers of one orphan create exactly one new attempt", async () => {
      const first = await reserved("race");
      await expire(first.request.id);
      const results = await Promise.all([
        tryKey("race", { takeover: { requestId: first.request.id, estimate } }),
        tryKey("race", { takeover: { requestId: first.request.id, estimate } }),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual(["in_progress", "reserved"]);
      expect((await attemptsOf("race")).map((row) => row.attempt)).toEqual([1, 2]);
    });

    it("refuses once a key has used its attempts, reading the newest attempt", async () => {
      const first = await reserved("cap", { maxAttempts: 2 });
      await expire(first.request.id);
      const second = await reserved("cap", {
        maxAttempts: 2,
        takeover: { requestId: first.request.id, estimate },
      });
      await expire(second.request.id);
      expect(await tryKey("cap", { maxAttempts: 2 })).toMatchObject({
        outcome: "attempts_exhausted",
        request: { id: second.request.id, attempt: 2 },
      });
      expect((await attemptsOf("cap")).map((row) => row.attempt)).toEqual([1, 2]);
    });

    it("keeps answering duplicate for completed, live-uncertain, released, unleased and different-body requests", async () => {
      const completed = await reserved("dup-completed");
      await ledger.complete(completed.request.id, usage, 0.00001, 200);
      const uncertain = await reserved("dup-uncertain");
      await ledger.markUncertain(uncertain.request.id, 502, estimate);
      const released = await reserved("dup-released");
      await ledger.release(released.request.id, 500);
      const unleased = await reserved("dup-unleased", { ownerId: undefined, leaseMs: undefined });
      const other = await reserved("dup-body");
      // The unleased row is left as it is: expiring it would give it a lease.
      await Promise.all([uncertain, other].map((row) => expire(row.request.id)));

      for (const [key, row] of [
        ["dup-completed", completed],
        ["dup-uncertain", uncertain],
        ["dup-released", released],
        ["dup-unleased", unleased],
      ] as const) {
        expect(await tryKey(key)).toMatchObject({ outcome: "duplicate", request: { id: row.request.id } });
      }
      expect(await tryKey("dup-body", { requestFingerprint: "another body" })).toMatchObject({
        outcome: "duplicate",
        request: { id: other.request.id },
      });
    });

    it("counts the first attempt's estimate and the new attempt's hold against the budget", async () => {
      // A hold as large as the whole budget never fits, so the refusal's numbers show what counted.
      const first = await reserved("budget");
      await expire(first.request.id);
      await reserved("budget", { takeover: { requestId: first.request.id, estimate } });
      const refused = await tryKey("budget-other", { reservationUsd: 0.01 });
      expect(refused).toMatchObject({ outcome: "budget_exhausted" });
      const details = (refused as { details: { spentUsd: number; heldReservedUsd: number } }).details;
      expect(details.spentUsd).toBeGreaterThanOrEqual(0.00002);
      expect(details.heldReservedUsd).toBeGreaterThanOrEqual(0.0001);
    });
  });

  describe("MCP sessions", () => {
    const mAgent = `mcp-agent-${suffix}`;
    const mRun = `mcp-run-${suffix}`;
    const nRun = `mcp-none-run-${suffix}`;
    const pin = {
      exposedName: "docs__search",
      toolName: "search",
      serverId: "server-1",
      serverName: "docs",
      callTimeoutMs: 5_000,
      definition: { description: "Search docs", inputSchema: { type: "object" } },
    };

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "runId" IN (${mRun}, ${nRun})`;
      await db.codingRun.deleteMany({ where: { runId: { in: [mRun, nRun] } } });
      await db.run.deleteMany({ where: { id: { in: [mRun, nRun] } } });
      await db.agent.deleteMany({ where: { id: mAgent } });
    });

    it("stores pins and the MCP token hash, finds the session by that hash, and counts no calls", async () => {
      await db.agent.create({
        data: { id: mAgent, name: mAgent, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
      });
      for (const id of [mRun, nRun]) {
        await db.run.create({ data: { id, agentId: mAgent, executionManaged: true } });
        await db.codingRun.create({
          data: {
            runId: id,
            task: "test",
            repository: "openai/example",
            baseRef: "main",
            headRef: `wardby/run-${id}`,
            provider: "codex",
            model: "gpt-5.6-luna",
            timeoutSec: 60,
            allowedEgress: [],
            protectedPaths: [],
            budgetReservedUsd: 1,
          },
        });
      }
      const ledger = new PrismaProxyLedger(db);
      const base = {
        credentialRef: "openai/test",
        protocol: "openai-responses" as const,
        allowedModels: ["gpt-5.6-luna"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
      };
      await ledger.createSession({
        ...base,
        id: `mcp-session-${suffix}`,
        runId: mRun,
        capabilityHash: `mcp-cap-${suffix}`,
        registryTokenHash: `mcp-registry-${suffix}`,
        mcpTools: [pin],
        mcpTokenHash: `mcp-token-hash-${suffix}`,
      });
      await ledger.createSession({
        ...base,
        id: `mcp-none-session-${suffix}`,
        runId: nRun,
        capabilityHash: `mcp-none-cap-${suffix}`,
        registryTokenHash: `mcp-none-registry-${suffix}`,
      });

      const found = await new PrismaProxyLedger(db).findSessionByMcpTokenHash(`mcp-token-hash-${suffix}`);
      expect(found).toMatchObject({
        id: `mcp-session-${suffix}`,
        runId: mRun,
        status: "active",
        mcpTools: [pin],
        mcpTokenHash: `mcp-token-hash-${suffix}`,
        mcpCallCount: 0,
      });
      expect(await ledger.findSessionByMcpTokenHash(`missing-${suffix}`)).toBeUndefined();
      expect(await ledger.findSessionByCapabilityHash(`mcp-cap-${suffix}`)).toMatchObject({
        mcpTools: [pin],
        mcpTokenHash: `mcp-token-hash-${suffix}`,
        mcpCallCount: 0,
      });
      expect(await ledger.findSessionByCapabilityHash(`mcp-none-cap-${suffix}`)).toMatchObject({
        mcpTools: null,
        mcpTokenHash: null,
        mcpCallCount: 0,
      });
    });

    it("reads a session holding native tool pins next to MCP pins", async () => {
      const kRun = `mcp-native-run-${suffix}`;
      await db.run.create({ data: { id: kRun, agentId: mAgent, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: kRun,
          task: "test",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${kRun}`,
          provider: "claude-code",
          model: "claude-sonnet-4-6",
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 1,
        },
      });
      const native = {
        kind: "native" as const,
        exposedName: "code_search",
        toolId: "tool-1",
        toolName: "code_search",
        definition: { description: "Search code", inputSchema: { type: "object" } },
      };
      // Dispatch writes the pinned version and grants; the proxy's read leaves them out.
      const pinnedNative = {
        ...native,
        pinned: {
          code: 'return await secrets.get("API_KEY");',
          paramsZod: "z.object({})",
          grants: {
            allowedSecrets: ["API_KEY"],
            allowedDatastorePrefixes: [],
            allowedHosts: [],
            allowedSharedDatastorePrefixes: {},
          },
        },
      };
      const mcpKindPin = { ...pin, kind: "mcp" as const, exposedName: "github__other" };
      const ledger = new PrismaProxyLedger(db);
      try {
        await ledger.createSession({
          credentialRef: "anthropic/test",
          protocol: "anthropic-messages",
          allowedModels: ["claude-sonnet-4-6"],
          deadlineAt: new Date(Date.now() + 60_000),
          budgetUsd: 1,
          id: `mcp-native-session-${suffix}`,
          runId: kRun,
          capabilityHash: `mcp-native-cap-${suffix}`,
          registryTokenHash: `mcp-native-registry-${suffix}`,
          mcpTools: [pin, pinnedNative, mcpKindPin],
          mcpTokenHash: `mcp-native-token-hash-${suffix}`,
        });
        const read = await ledger.findSessionByMcpTokenHash(`mcp-native-token-hash-${suffix}`);
        // An MCP pin marked kind "mcp" reads like one with no kind; a native pin loses its code and grants.
        expect(read?.mcpTools).toEqual([pin, native, mcpKindPin]);
        expect(JSON.stringify(read)).not.toContain("secrets.get");
        expect(JSON.stringify(read)).not.toContain("API_KEY");
        // A pin of neither shape still refuses the session.
        await db.$executeRaw`UPDATE "CodingProxySession" SET "mcpTools" = ${JSON.stringify([{ kind: "native", exposedName: "x" }])}::jsonb WHERE "runId" = ${kRun}`;
        await expect(ledger.findSessionByMcpTokenHash(`mcp-native-token-hash-${suffix}`)).rejects.toThrow(
          "invalid_proxy_session_mcp_tools",
        );
      } finally {
        await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "runId" = ${kRun}`;
        await db.codingRun.deleteMany({ where: { runId: kRun } });
        await db.run.deleteMany({ where: { id: kRun } });
      }
    });
  });
  describe("tunnel sessions", () => {
    const tAgent = `tunnel-agent-${suffix}`;
    const tRun = `tunnel-run-${suffix}`;
    const oRun = `tunnel-old-run-${suffix}`;
    const eRun = `tunnel-expired-run-${suffix}`;
    const dRun = `tunnel-dup-run-${suffix}`;

    afterAll(async () => {
      await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "runId" IN (${tRun}, ${oRun}, ${eRun}, ${dRun})`;
      await db.codingRun.deleteMany({ where: { runId: { in: [tRun, oRun, eRun, dRun] } } });
      await db.run.deleteMany({ where: { id: { in: [tRun, oRun, eRun, dRun] } } });
      await db.agent.deleteMany({ where: { id: tAgent } });
    });

    it("stores the tunnel token hash, finds the session by it, and tells whether the run is active", async () => {
      await db.agent.create({
        data: { id: tAgent, name: tAgent, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
      });
      for (const id of [tRun, oRun, eRun, dRun]) {
        await db.run.create({ data: { id, agentId: tAgent, executionManaged: true } });
        await db.codingRun.create({
          data: {
            runId: id,
            task: "test",
            repository: "openai/example",
            baseRef: "main",
            headRef: `wardby/run-${id}`,
            provider: "codex",
            model: "gpt-5.6-luna",
            timeoutSec: 60,
            allowedEgress: [],
            protectedPaths: [],
            budgetReservedUsd: 1,
          },
        });
      }
      const ledger = new PrismaProxyLedger(db);
      const base = {
        credentialRef: "openai/test",
        protocol: "openai-responses" as const,
        allowedModels: ["gpt-5.6-luna"],
        budgetUsd: 1,
      };
      await ledger.createSession({
        ...base,
        id: `tunnel-session-${suffix}`,
        runId: tRun,
        capabilityHash: `tunnel-cap-${suffix}`,
        registryTokenHash: `tunnel-registry-${suffix}`,
        tunnelTokenHash: `tunnel-token-hash-${suffix}`,
        deadlineAt: new Date(Date.now() + 60_000),
      });
      await ledger.createSession({
        ...base,
        id: `tunnel-old-session-${suffix}`,
        runId: oRun,
        capabilityHash: `tunnel-old-cap-${suffix}`,
        registryTokenHash: `tunnel-old-registry-${suffix}`,
        deadlineAt: new Date(Date.now() + 60_000),
      });
      await ledger.createSession({
        ...base,
        id: `tunnel-expired-session-${suffix}`,
        runId: eRun,
        capabilityHash: `tunnel-expired-cap-${suffix}`,
        registryTokenHash: `tunnel-expired-registry-${suffix}`,
        tunnelTokenHash: `tunnel-expired-hash-${suffix}`,
        deadlineAt: new Date(Date.now() - 1_000),
      });

      expect(await ledger.findSessionByTunnelTokenHash(`tunnel-token-hash-${suffix}`)).toMatchObject({
        id: `tunnel-session-${suffix}`,
        runId: tRun,
        status: "active",
        tunnelTokenHash: `tunnel-token-hash-${suffix}`,
      });
      expect(await ledger.findSessionByTunnelTokenHash(`tunnel-registry-${suffix}`)).toBeUndefined();
      expect(await ledger.findSessionByTunnelTokenHash(`tunnel-cap-${suffix}`)).toBeUndefined();
      // Only the tunnel lookup selects the hash: the capability lookup is unchanged.
      expect(await ledger.findSessionByCapabilityHash(`tunnel-cap-${suffix}`)).not.toHaveProperty("tunnelTokenHash");

      expect(await ledger.sessionActiveForRun(tRun)).toBe(true);
      expect(await ledger.sessionActiveForRun(oRun)).toBe(true);
      expect(await ledger.sessionActiveForRun(eRun)).toBe(false);
      expect(await ledger.sessionActiveForRun(`missing-${suffix}`)).toBe(false);
      await ledger.cancelSession(`tunnel-session-${suffix}`);
      expect(await ledger.sessionActiveForRun(tRun)).toBe(false);
    });

    it("refuses a second session with the same tunnel token hash", async () => {
      const ledger = new PrismaProxyLedger(db);
      await expect(
        ledger.createSession({
          id: `tunnel-dup-session-${suffix}`,
          runId: dRun,
          capabilityHash: `tunnel-dup-cap-${suffix}`,
          registryTokenHash: `tunnel-dup-registry-${suffix}`,
          tunnelTokenHash: `tunnel-token-hash-${suffix}`,
          credentialRef: "openai/test",
          protocol: "openai-responses",
          allowedModels: ["gpt-5.6-luna"],
          budgetUsd: 1,
          deadlineAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow();
    });
  });
});
