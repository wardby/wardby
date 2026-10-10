import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import type { NativeRunProviders } from "../core/runner.js";
import { nativeIsolationNames, nativeRunLabel } from "./docker-isolation.js";
import type { NativeWorkerState } from "./docker-launcher.js";
import { identityCipher, memoryDatastore, MODEL, noMemory, script, scriptedModel } from "./fixtures.test-support.js";
import type { WorkerHandle } from "./launch.js";
import type { WorkerInput } from "./protocol.js";
import { NativeSandboxExecutor, type ManagedWorkerLauncher } from "./sandbox-executor.js";
import { PrismaGatewayLedger } from "./ledger.js";
import { PooledWorkerLauncher, type WarmWorkerLauncher } from "./warm-pool.js";
import { PrismaWarmPoolLedger } from "./warm-pool-ledger.js";
import { lockWarmPoolTable, LOCK_WAIT_MS } from "./warm-pool-lock.test-support.js";

/** A launcher whose workers exit only when the test says so. */
function fakeLauncher() {
  const launched: WorkerInput[] = [];
  const killed: string[] = [];
  const removed: string[] = [];
  const exits = new Map<string, (code: number | null) => void>();
  const states = new Map<string, NativeWorkerState>();
  const handle = (runId: string): WorkerHandle => ({
    exited: new Promise((resolve) => exits.set(runId, resolve)),
    kill: () => {
      killed.push(runId);
      exits.get(runId)?.(137);
    },
  });
  const launcher: ManagedWorkerLauncher = {
    async launch(input) {
      launched.push(input);
      states.set(input.runId, { state: "running" });
      return handle(input.runId);
    },
    handle,
    inspect: async (runId) => states.get(runId) ?? { state: "missing" },
    kill: async (runId) => void killed.push(runId),
    remove: async (runId) => void removed.push(runId),
    listWorkers: async () =>
      [...states.keys()].map((runId) => ({ name: nativeIsolationNames(runId).worker, runHash: nativeRunLabel(runId) })),
    removeByWorkerName: async (name) => void removed.push(name),
  };
  const exit = (runId: string, code: number) => exits.get(runId)?.(code);
  return { launcher, launched, killed, removed, states, exit };
}

describe.skipIf(!process.env.DATABASE_URL)("NativeSandboxExecutor (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `nse-owner-${tag}`;
  const agentId = `nse-agent-${tag}`;
  const providers: NativeRunProviders = {
    llm: scriptedModel(script()).llm,
    engine: new NativeEngine(),
    datastore: memoryDatastore({}),
    secrets: identityCipher,
    memory: noMemory,
  };
  const gatewayUrl = "http://wardby-native-gateway:8790/native-gateway/v1/call";

  let release: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    release = await lockWarmPoolTable();
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "s", model: MODEL, budgetUsd: 1, maxTurns: 3, ownerId },
    });
  }, LOCK_WAIT_MS);
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
    await release?.();
  });

  const sandboxRun = () => db.run.create({ data: { agentId, nativeExecutionMode: "sandbox", executionManaged: true } });
  const executorWith = (launcher: ManagedWorkerLauncher, now?: () => number) =>
    new NativeSandboxExecutor({ db, providers, launcher, gatewayUrl, now });
  const row = (id: string) => db.run.findUniqueOrThrow({ where: { id } });

  it("starts: session and backend recorded before launch, the worker given the gateway URL and a capability", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    await executorWith(fake.launcher).start(run.id);
    expect(fake.launched).toHaveLength(1);
    expect(fake.launched[0].gateway).toMatchObject({ url: gatewayUrl, capability: expect.any(String) });
    expect(await row(run.id)).toMatchObject({ status: "running", executionBackend: "native-sandbox" });
    const session = await db.nativeGatewaySession.findUniqueOrThrow({ where: { runId: run.id } });
    expect(session.status).toBe("active");
    expect(JSON.stringify(session)).not.toContain(fake.launched[0].gateway!.capability);
  });

  it("never launches a second worker for a run started twice, one after the other or at once", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    const executor = executorWith(fake.launcher);
    await executor.start(run.id);
    await executor.start(run.id);
    expect(fake.launched).toHaveLength(1);

    const raced = await sandboxRun();
    await Promise.all([executor.start(raced.id), executorWith(fake.launcher).start(raced.id)]);
    expect(fake.launched.filter((i) => i.runId === raced.id)).toHaveLength(1);
  });

  it("refuses a start past NATIVE_SANDBOX_MAX_CONCURRENT active sessions, launching nothing", async () => {
    const fake = fakeLauncher();
    const first = await sandboxRun();
    await executorWith(fake.launcher).start(first.id);
    // A cap of 1 is full whatever other test files do: this test's own first session stays
    // active, while sessions elsewhere in the shared database can end at any moment.
    const full = new NativeSandboxExecutor({
      db,
      providers,
      launcher: fake.launcher,
      gatewayUrl,
      maxConcurrent: 1,
    });
    const second = await sandboxRun();
    await expect(full.start(second.id)).rejects.toThrow(/native_sandbox_capacity/);
    expect(fake.launched.map((i) => i.runId)).toEqual([first.id]);
    expect(await db.nativeGatewaySession.findUnique({ where: { runId: second.id } })).toBeNull();
  });

  it("fails a run whose worker exits without a result, and removes the worker", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    await executorWith(fake.launcher).start(run.id);
    fake.exit(run.id, 1);
    await vi.waitFor(async () => expect((await row(run.id)).status).toBe("failed"));
    expect((await row(run.id)).error).toMatch(/^native_sandbox_worker_exited: .*code 1/);
    await vi.waitFor(() => expect(fake.removed).toContain(run.id));
    expect((await db.nativeGatewaySession.findUniqueOrThrow({ where: { runId: run.id } })).status).toBe("finished");
  });

  it("leaves a run the worker finished alone when the worker exits", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    await executorWith(fake.launcher).start(run.id);
    await db.run.update({ where: { id: run.id }, data: { status: "succeeded", finalText: "done" } });
    fake.exit(run.id, 0);
    await vi.waitFor(() => expect(fake.removed).toContain(run.id));
    expect(await row(run.id)).toMatchObject({ status: "succeeded", finalText: "done" });
  });

  it("stops at the run's deadline: kills the worker and fails the run as past its deadline", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    // A clock far past any deadline the session gets.
    await executorWith(fake.launcher, () => Date.now() + 10 * 24 * 3600 * 1000).start(run.id);
    await vi.waitFor(async () => expect((await row(run.id)).status).toBe("failed"));
    expect(fake.killed).toContain(run.id);
    expect((await row(run.id)).error).toMatch(/^native_sandbox_deadline_exceeded/);
  });

  it("stops a run: session cancelled, worker killed and removed, run recorded cancelled with the reason", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    const executor = executorWith(fake.launcher);
    await executor.start(run.id);
    await executor.stop(run.id, "operator cancelled");
    expect(await row(run.id)).toMatchObject({ status: "cancelled", error: "operator cancelled" });
    expect(fake.killed).toContain(run.id);
    expect(fake.removed).toContain(run.id);
    expect((await db.nativeGatewaySession.findUniqueOrThrow({ where: { runId: run.id } })).status).toBe("cancelled");
  });

  it("recovers from the container's state and never relaunches", async () => {
    const fake = fakeLauncher();
    const executor = executorWith(fake.launcher);
    const handleFor = (runId: string) => ({ runId, backend: "native-sandbox", id: runId });

    const running = await sandboxRun();
    await executor.start(running.id);
    expect(await executorWith(fake.launcher).recover(handleFor(running.id))).toEqual({ state: "active" });

    const exited = await sandboxRun();
    await executor.start(exited.id);
    fake.states.set(exited.id, { state: "exited", exitCode: 2 });
    expect(await executorWith(fake.launcher).recover(handleFor(exited.id))).toEqual({ state: "terminal" });
    expect((await row(exited.id)).status).toBe("failed");

    const vanished = await sandboxRun();
    await executor.start(vanished.id);
    fake.states.delete(vanished.id);
    expect(await executorWith(fake.launcher).recover(handleFor(vanished.id))).toMatchObject({
      state: "lost",
      reason: expect.stringMatching(/^native_sandbox_worker_lost/),
    });
    expect(fake.launched.filter((i) => i.runId === vanished.id)).toHaveLength(1);

    expect(await executor.recover({ runId: running.id, backend: "dbos", id: running.id })).toMatchObject({
      state: "lost",
    });
  });

  it("sweeps away workers whose runs ended, and keeps live ones", async () => {
    const fake = fakeLauncher();
    const executor = executorWith(fake.launcher);
    const live = await sandboxRun();
    const ended = await sandboxRun();
    await executor.start(live.id);
    await executor.start(ended.id);
    await db.run.update({ where: { id: ended.id }, data: { status: "succeeded" } });
    expect(await executor.sweep()).toBe(1);
    expect(fake.removed).toEqual([nativeIsolationNames(ended.id).worker]);
  });

  it("launch() sweeps, then starts the launcher's upkeep; a failing upkeep never fails it", async () => {
    const fake = fakeLauncher();
    const start = vi.fn(async () => {
      throw new Error("pool down");
    });
    await expect(executorWith({ ...fake.launcher, start }).launch()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("runs a sandbox run on a claimed warm worker: input delivered after the claim, session ready, worker removed with its row", async () => {
    const fake = fakeLauncher();
    let tokens = 0;
    const warm = new Map<string, WorkerInput | undefined>();
    const exits = new Map<string, (code: number | null) => void>();
    const warmOps: WarmWorkerLauncher = {
      warmSpecHash: (waitMs) => `exec-test-${tag}:${waitMs}`,
      startWarm: async (token) => void warm.set(token, undefined),
      reattestWarm: async (token) => warm.has(token),
      deliver: async (token, input) => void warm.set(token, input),
      warmHandle: (token) => ({ exited: new Promise((resolve) => exits.set(token, resolve)), kill: () => {} }),
      inspectWarm: async (token) => (warm.has(token) ? { state: "running" } : { state: "missing" }),
      killWarm: async (token) => void exits.get(token)?.(137),
      removeWarm: async (token) => void warm.delete(token),
      listWarm: async () => [...warm.keys()],
    };
    const pool = new PooledWorkerLauncher({
      ledger: new PrismaWarmPoolLedger(db),
      launcher: { ...fake.launcher, ...warmOps, networkReadyAtLaunch: false },
      size: 1,
      maxAgeMs: 60_000,
      warmTimeoutMs: 10_000,
      onDelivered: (runId) => new PrismaGatewayLedger(db).markNetworkReadyForRun(runId),
      newToken: () => `${tag}${String((tokens += 1)).padStart(12, "0")}`,
    });
    await pool.tick();
    await pool.settled();
    const token = `${tag}${"1".padStart(12, "0")}`;
    expect(warm.has(token) && warm.get(token) === undefined).toBe(true);
    const run = await sandboxRun();
    await executorWith(pool).start(run.id);
    expect(fake.launched).toHaveLength(0);
    expect(warm.get(token)?.gateway?.capability).toEqual(expect.any(String));
    const session = await db.nativeGatewaySession.findUniqueOrThrow({ where: { runId: run.id } });
    expect(session.networkReadyAt).toBeInstanceOf(Date);
    // The worker exits without a result: the run fails, and the worker and its row are removed.
    exits.get(token)?.(1);
    await vi.waitFor(async () => expect((await row(run.id)).status).toBe("failed"));
    await vi.waitFor(async () => {
      expect(warm.has(token)).toBe(false);
      expect(await db.nativeWarmWorker.findUnique({ where: { id: token } })).toBeNull();
    });
    pool.stop();
    await pool.settled();
    await db.nativeWarmWorker.deleteMany({ where: { specHash: { startsWith: `exec-test-${tag}` } } });
  });
});
