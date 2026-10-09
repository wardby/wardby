import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { createSandboxSession, type NativeRunProviders } from "../core/runner.js";
import { identityCipher, memoryDatastore, MODEL, noMemory, script, scriptedModel } from "./fixtures.test-support.js";
import { serveGatewayRequest } from "./gateway-server.js";
import { PrismaGatewayLedger } from "./ledger.js";

describe.skipIf(!process.env.DATABASE_URL)("gateway readiness gate (database)", () => {
  const db = createPrismaClient();
  const ledger = new PrismaGatewayLedger(db);
  const tag = randomUUID().slice(0, 8);
  const agentId = `ready-agent-${tag}`;
  const providers: NativeRunProviders = {
    llm: scriptedModel(script()).llm,
    engine: new NativeEngine(),
    datastore: memoryDatastore({}),
    secrets: identityCipher,
    memory: noMemory,
  };

  beforeAll(async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "s", model: MODEL, budgetUsd: 1, maxTurns: 2 },
    });
  });
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  async function session(networkReady: boolean) {
    const run = await db.run.create({ data: { agentId, nativeExecutionMode: "sandbox", executionManaged: true } });
    const started = await createSandboxSession({
      runId: run.id,
      providers,
      db,
      ledger,
      gatewayUrl: "http://gw",
      networkReady,
    });
    if (started.kind !== "started") throw new Error("expected a session");
    return { runId: run.id, ...started };
  }
  const countTokens = (runId: string, callId: string) => ({
    v: 1,
    runId,
    callId,
    method: "llm.countTokens",
    params: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
  });

  it("serves nothing until the worker's network isolation is proven, then serves normally", async () => {
    const s = await session(false);
    const refused = await serveGatewayRequest({ db, providers }, `Bearer ${s.capability}`, countTokens(s.runId, "c-1"));
    expect(refused).toMatchObject({ kind: "json", status: 503, body: { ok: false, error: { code: "not_ready" } } });

    await ledger.markNetworkReady(s.sessionId);
    const served = await serveGatewayRequest({ db, providers }, `Bearer ${s.capability}`, countTokens(s.runId, "c-2"));
    expect(served).toMatchObject({ kind: "json", status: 200, body: { ok: true } });
  });

  it("creates a session ready when its isolation exists before the worker (Docker)", async () => {
    const s = await session(true);
    const served = await serveGatewayRequest({ db, providers }, `Bearer ${s.capability}`, countTokens(s.runId, "c-1"));
    expect(served).toMatchObject({ status: 200 });
  });
});
