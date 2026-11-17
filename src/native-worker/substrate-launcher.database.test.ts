import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { sandboxCapabilityHash, type NativeRunProviders } from "../core/runner.js";
import { nativeActorName, substrateRunToken } from "../providers/substrate/names.js";
import { identityCipher, memoryDatastore, MODEL, noMemory, script, scriptedModel } from "./fixtures.test-support.js";
import { NativeSandboxExecutor } from "./sandbox-executor.js";
import { nativeHarness } from "./substrate-launcher.test-support.js";
import { NATIVE_RUN_SECRET_KEY } from "./substrate-specs.js";

const GATEWAY_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/native-gateway/v1/call";

/** The real NativeSandboxExecutor over the real SubstrateNativeWorkerLauncher, on the fake Substrate API. */
describe.skipIf(!process.env.DATABASE_URL)("NativeSandboxExecutor over the Substrate launcher (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `nsl-owner-${tag}`;
  const agentId = `nsl-agent-${tag}`;
  const providers: NativeRunProviders = {
    llm: scriptedModel(script()).llm,
    engine: new NativeEngine(),
    datastore: memoryDatastore({}),
    secrets: identityCipher,
    memory: noMemory,
  };

  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "s", model: MODEL, budgetUsd: 1, maxTurns: 3, ownerId },
    });
  });
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  const sandboxRun = () => db.run.create({ data: { agentId, nativeExecutionMode: "sandbox", executionManaged: true } });
  const row = (id: string) => db.run.findUniqueOrThrow({ where: { id } });
  const session = (runId: string) => db.nativeGatewaySession.findUniqueOrThrow({ where: { runId } });

  /** A harness whose launcher reads session activity from the database, and an executor over it. */
  function setup(options: Parameters<typeof nativeHarness>[0] = {}, now?: () => number) {
    const h = nativeHarness({
      ...options,
      launcher: {
        sessionActive: async (runId) =>
          (await db.nativeGatewaySession.findUnique({ where: { runId }, select: { status: true } }))?.status ===
          "active",
        ...options.launcher,
      },
    });
    const executorOver = (clock?: () => number) =>
      new NativeSandboxExecutor({
        db,
        providers,
        launcher: h.launcher,
        gatewayUrl: GATEWAY_URL,
        stopGraceMs: 5_000,
        now: clock ?? now,
      });
    const keys = (runId: string) => {
      const token = substrateRunToken(runId);
      return {
        actor: `${h.config.atespace}/${nativeActorName(token)}`,
        actorName: nativeActorName(token),
        secret: `${h.config.credentialsNamespace}/${token}`,
      };
    };
    /** Nothing of the run is left: no actor, no policy, no Secret. */
    const expectNothingLeft = (runId: string) => {
      const k = keys(runId);
      expect(h.api.actors.has(k.actor)).toBe(false);
      expect(h.api.egressPolicies.has(k.actor)).toBe(false);
      expect(h.secrets.secrets.has(k.secret)).toBe(false);
    };
    return { h, executor: executorOver(), executorOver, keys, expectNothingLeft };
  }

  it("starts: session ready at creation, one actor, its Secret holds the session's capability", async () => {
    const { h, executor, keys } = setup();
    const run = await sandboxRun();
    await executor.start(run.id);
    const k = keys(run.id);
    const s = await session(run.id);
    expect(s.status).toBe("active");
    expect(s.networkReadyAt).not.toBeNull();
    expect(h.api.actors.get(k.actor)?.state).toBe("RUNNING");
    const capability = h.secrets.secrets.get(k.secret)?.stringData?.[NATIVE_RUN_SECRET_KEY];
    expect(capability).toEqual(expect.any(String));
    expect(sandboxCapabilityHash(capability!)).toBe(s.capabilityHash);
    expect(JSON.stringify(s.snapshot)).not.toContain(capability!);
    await executor.stop(run.id);
  });

  it("stops: run cancelled, actor, policy and Secret gone, workerRemovedAt set", async () => {
    const { h, executor, expectNothingLeft } = setup();
    const run = await sandboxRun();
    await executor.start(run.id);
    h.order.length = 0;
    await executor.stop(run.id, "operator cancelled");
    expect(await row(run.id)).toMatchObject({ status: "cancelled", error: "operator cancelled" });
    // The session ended first, so the grace saw an exited worker: no actor delete (a kill) came
    // before the removal's, which deletes the policy first.
    expect(h.order.indexOf("deleteEgressPolicy")).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf("deleteActor")).toBeGreaterThan(h.order.indexOf("deleteEgressPolicy"));
    expect((await session(run.id)).status).toBe("cancelled");
    expect((await session(run.id)).workerRemovedAt).not.toBeNull();
    expectNothingLeft(run.id);
  });

  it("fails a crashed worker as native_sandbox_worker_exited", async () => {
    const { h, executor, keys, expectNothingLeft } = setup();
    const run = await sandboxRun();
    await executor.start(run.id);
    h.api.setState(h.config.atespace, keys(run.id).actorName, "CRASHED");
    await vi.waitFor(async () => expect((await row(run.id)).status).toBe("failed"));
    expect((await row(run.id)).error).toMatch(/^native_sandbox_worker_exited: .*\(code 1\)/);
    await vi.waitFor(async () => expect((await session(run.id)).workerRemovedAt).not.toBeNull());
    expectNothingLeft(run.id);
  });

  it("kills a worker at its deadline", async () => {
    const { executorOver, expectNothingLeft } = setup();
    const run = await sandboxRun();
    // A clock far past any deadline the session gets.
    await executorOver(() => Date.now() + 10 * 24 * 3600 * 1000).start(run.id);
    await vi.waitFor(async () => expect((await row(run.id)).status).toBe("failed"));
    expect((await row(run.id)).error).toMatch(/^native_sandbox_deadline_exceeded/);
    await vi.waitFor(async () => expect((await session(run.id)).workerRemovedAt).not.toBeNull());
    expectNothingLeft(run.id);
  });

  it("recovers: re-attaches a running actor; a gone one is lost", async () => {
    const { h, executor, executorOver, keys, expectNothingLeft } = setup();
    const handleFor = (runId: string) => ({ runId, backend: "native-sandbox", id: runId });
    const running = await sandboxRun();
    await executor.start(running.id);
    expect(await executorOver().recover(handleFor(running.id))).toEqual({ state: "active" });

    const vanished = await sandboxRun();
    await executor.start(vanished.id);
    await h.api.deleteActor(h.config.atespace, keys(vanished.id).actorName);
    expect(await executorOver().recover(handleFor(vanished.id))).toMatchObject({
      state: "lost",
      reason: expect.stringMatching(/^native_sandbox_worker_lost/),
    });
    await executor.stop(running.id);
    await executor.stop(vanished.id);
    expectNothingLeft(running.id);
    expectNothingLeft(vanished.id);
  });

  it("sweeps a leftover from the rows", async () => {
    const { h, executor, keys, expectNothingLeft } = setup();
    const run = await sandboxRun();
    await executor.start(run.id);
    // The run ends in the database while its actor is still there.
    await db.run.update({ where: { id: run.id }, data: { status: "succeeded" } });
    expect(h.api.actors.has(keys(run.id).actor)).toBe(true);
    // Counts every ended session in the shared database; only this run's own row is asserted on.
    expect(await executor.sweep()).toBeGreaterThanOrEqual(1);
    expectNothingLeft(run.id);
    expect((await session(run.id)).workerRemovedAt).not.toBeNull();
  });

  it("fails capacity without leaving anything", async () => {
    const { executor, expectNothingLeft, h } = setup({
      fake: { workerSize: { cpuMillicores: 10, memoryBytes: 2 ** 20 } },
      goldenWaitMs: 0,
    });
    const run = await sandboxRun();
    await expect(executor.start(run.id)).rejects.toThrow(/^native_sandbox_capacity/);
    expect((await session(run.id)).status).toBe("cancelled");
    expect(h.secrets.secrets.size).toBe(0);
    expectNothingLeft(run.id);
  });
});
