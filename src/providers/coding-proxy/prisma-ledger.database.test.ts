import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../core/db.js";
import { afterAll, describe, expect, it } from "vitest";
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
        details: expect.objectContaining({ source: "proxy", turn: 1, refusedHoldUsd: 0.0001 }),
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

    it("hints the latest completed, non-estimated reply of the model and the median output", async () => {
      await ledger.complete(await reserved("c1", 0.0001), u(100, 20, 5, 8), 0.00001, 200);
      await ledger.complete(await reserved("c2", 0.0001), u(200, 0, 0, 30), 0.00002, 200);
      await ledger.complete(await reserved("c3", 0.0001, otherModel), u(300, 0, 0, 12), 0.00001, 200);
      expect(await ledger.settlementHints(eSession, model)).toEqual({
        previous: u(200, 0, 0, 30),
        medianOutputTokens: 12,
      });
      expect(await ledger.settlementHints(eSession, "no-such-model")).toEqual({ medianOutputTokens: 12 });
      expect(await ledger.settlementHints(`missing-${suffix}`, model)).toEqual({});
    });
  });
});
