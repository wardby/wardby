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
import { reconcileOnce } from "../core/reconciler.js";
import { HEARTBEAT_TIMEOUT_MS } from "../core/timing.js";
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
  const executorWith = (
    launcher: ManagedWorkerLauncher,
    now?: () => number,
    stop: { stopGraceMs?: number; sleep?: (ms: number) => Promise<void> } = { stopGraceMs: 0 },
  ) => new NativeSandboxExecutor({ db, providers, launcher, gatewayUrl, now, ...stop });
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

  // A cold launch (a low-power gateway wake, then a sandbox node scale-up) can take minutes, with no
  // worker pod for recovery to find; the run must not be reaped as orphaned meanwhile.
  it("keeps a slowly launching run's heartbeat fresh, so the reconciler leaves it alone", async () => {
    const fake = fakeLauncher();
    let finishLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => (finishLaunch = resolve));
    const slow: ManagedWorkerLauncher = {
      ...fake.launcher,
      launch: async (input, options) => {
        await launchGate;
        expect(await options?.stillWanted?.()).toBe(true);
        return fake.launcher.launch(input, options);
      },
    };
    const run = await sandboxRun();
    const executor = new NativeSandboxExecutor({ db, providers, launcher: slow, gatewayUrl, heartbeatIntervalMs: 5 });
    const started = executor.start(run.id);
    await vi.waitFor(async () => expect((await row(run.id)).heartbeatAt).not.toBeNull());

    // Long after the run started, but its heartbeat is fresh: nothing to recover, nothing lost.
    const recover = vi.spyOn(executor, "recover");
    const lateBy = HEARTBEAT_TIMEOUT_MS + 60_000;
    await db.run.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - lateBy) } });
    expect(await reconcileOnce(db, new Date(), HEARTBEAT_TIMEOUT_MS, executor)).toBe(0);
    expect(recover).not.toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }));
    expect((await row(run.id)).status).toBe("running");

    finishLaunch();
    await started;
    expect(fake.launched).toHaveLength(1);
    // Beats stop with the launch: the worker's progress and recovery take over.
    const beat = (await row(run.id)).heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await row(run.id)).heartbeatAt).toEqual(beat);
  });

  it("tells the launcher a run stopped mid-launch is no longer wanted", async () => {
    const fake = fakeLauncher();
    let wanted: boolean | undefined;
    let finishLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => (finishLaunch = resolve));
    const slow: ManagedWorkerLauncher = {
      ...fake.launcher,
      launch: async (input, options) => {
        await launchGate;
        wanted = await options?.stillWanted?.();
        if (!wanted) throw new Error("native_sandbox_launch_abandoned: test");
        return fake.launcher.launch(input, options);
      },
    };
    const run = await sandboxRun();
    const executor = executorWith(slow);
    const started = executor.start(run.id).catch((err: unknown) => err);
    await vi.waitFor(async () =>
      expect(await db.nativeGatewaySession.findUnique({ where: { runId: run.id } })).not.toBeNull(),
    );
    await executor.stop(run.id, "requested");
    finishLaunch();
    expect(await started).toBeInstanceOf(Error);
    expect(wanted).toBe(false);
    expect(fake.launched).toHaveLength(0);
    expect((await row(run.id)).status).toBe("cancelled");
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

  it("stops a pending sandbox run before any worker exists: cancelled, nothing to kill, and a later start launches nothing", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    const executor = executorWith(fake.launcher, undefined, { stopGraceMs: 5_000 });
    await executor.stop(run.id, "stopped while pending");
    expect(await row(run.id)).toMatchObject({ status: "cancelled", error: "stopped while pending" });
    expect(fake.killed).toEqual([]);
    await executor.start(run.id);
    expect(fake.launched).toHaveLength(0);
  });

  it("stops a running sandbox run cooperatively: the worker exits on its own within the grace and is not killed", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    const sleeps: number[] = [];
    const executor = executorWith(fake.launcher, undefined, {
      stopGraceMs: 5_000,
      // The worker's next gateway call is refused (its session is ended), so it exits.
      sleep: async (ms) => {
        sleeps.push(ms);
        fake.states.set(run.id, { state: "exited", exitCode: 1 });
      },
    });
    await executor.start(run.id);
    await executor.stop(run.id, "operator stopped it");
    expect(await row(run.id)).toMatchObject({ status: "cancelled", error: "operator stopped it" });
    expect((await db.nativeGatewaySession.findUniqueOrThrow({ where: { runId: run.id } })).status).toBe("cancelled");
    expect(sleeps).toHaveLength(1);
    expect(fake.killed).not.toContain(run.id);
    expect(fake.removed).toContain(run.id);
  });

  it("kills a stopped sandbox run's worker that is still running when its grace runs out", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    let clock = Date.now();
    const executor = executorWith(fake.launcher, () => clock, {
      stopGraceMs: 1_000,
      sleep: async (ms) => void (clock += ms),
    });
    await executor.start(run.id);
    await executor.stop(run.id, "operator stopped it");
    expect(fake.killed).toContain(run.id);
    expect(fake.removed).toContain(run.id);
    expect((await row(run.id)).status).toBe("cancelled");
  });

  it("leaves a finished sandbox run's result alone when stopped late", async () => {
    const fake = fakeLauncher();
    const run = await sandboxRun();
    await db.run.update({ where: { id: run.id }, data: { status: "succeeded", finishedAt: new Date() } });
    await executorWith(fake.launcher).stop(run.id, "too late");
    expect(await row(run.id)).toMatchObject({ status: "succeeded", error: null });
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
  it("stops a run on a claimed warm worker: the worker is discarded with its row, never returned to the pool", async () => {
    const fake = fakeLauncher();
    let tokens = 900;
    const warm = new Map<string, WorkerInput | undefined>();
    const warmOps: WarmWorkerLauncher = {
      warmSpecHash: (waitMs) => `stop-test-${tag}:${waitMs}`,
      startWarm: async (token) => void warm.set(token, undefined),
      reattestWarm: async (token) => warm.has(token),
      deliver: async (token, input) => void warm.set(token, input),
      warmHandle: () => ({ exited: new Promise(() => {}), kill: () => {} }),
      inspectWarm: async (token) => (warm.has(token) ? { state: "running" } : { state: "missing" }),
      killWarm: async (token) => void fake.killed.push(token),
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
    const token = `${tag}${"901".padStart(12, "0")}`;
    expect(warm.has(token)).toBe(true);
    const run = await sandboxRun();
    const executor = executorWith(pool);
    await executor.start(run.id);
    expect(warm.get(token)?.runId).toBe(run.id);
    await executor.stop(run.id, "operator stopped it");
    expect((await row(run.id)).status).toBe("cancelled");
    expect(fake.killed).toContain(token);
    expect(warm.has(token)).toBe(false);
    expect(await db.nativeWarmWorker.findUnique({ where: { id: token } })).toBeNull();
    pool.stop();
    await pool.settled();
    await db.nativeWarmWorker.deleteMany({ where: { specHash: { startsWith: `stop-test-${tag}` } } });
  });
});
