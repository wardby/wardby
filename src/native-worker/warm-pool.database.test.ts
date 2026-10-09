import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../core/db.js";
import type { NativeWorkerState } from "./docker-launcher.js";
import type { WorkerHandle } from "./launch.js";
import type { WorkerInput } from "./protocol.js";
import type { ManagedWorkerLauncher } from "./sandbox-executor.js";
import { PooledWorkerLauncher, type WarmWorkerLauncher } from "./warm-pool.js";
import { PrismaWarmPoolLedger } from "./warm-pool-ledger.js";

/** Pool workers and cold workers in memory, recording what reached each. */
class FakeLauncher implements ManagedWorkerLauncher, WarmWorkerLauncher {
  readonly networkReadyAtLaunch = false;
  readonly warm = new Map<string, { state: NativeWorkerState["state"]; input?: WorkerInput }>();
  readonly cold = new Map<string, WorkerInput>();
  spec = "spec-a";
  failStart = false;
  failDeliver = false;
  intact = true;
  /** Lets a removed worker linger (a delivery-failed worker that will not die). */
  removeLeaves = false;

  warmSpecHash(waitMs: number) {
    return `${this.spec}:${waitMs}`;
  }
  async startWarm(token: string) {
    if (this.failStart) throw new Error("no room");
    this.warm.set(token, { state: "running" });
  }
  async reattestWarm(token: string) {
    return this.intact && this.warm.get(token)?.state === "running";
  }
  async deliver(token: string, input: WorkerInput) {
    const worker = this.warm.get(token)!;
    worker.input = input;
    if (this.failDeliver) throw new Error("exec dropped");
  }
  warmHandle(token: string): WorkerHandle {
    return { exited: new Promise(() => {}), kill: () => this.warm.delete(token) };
  }
  async inspectWarm(token: string): Promise<NativeWorkerState> {
    const worker = this.warm.get(token);
    if (!worker) return { state: "missing" };
    return worker.state === "exited" ? { state: "exited", exitCode: 75 } : { state: "running" };
  }
  async killWarm(token: string) {
    this.warm.delete(token);
  }
  async removeWarm(token: string) {
    if (!this.removeLeaves) this.warm.delete(token);
  }
  async listWarm() {
    return [...this.warm.keys()];
  }
  async launch(input: WorkerInput): Promise<WorkerHandle> {
    this.cold.set(input.runId, input);
    return { exited: new Promise(() => {}), kill: () => {} };
  }
  handle(): WorkerHandle {
    return { exited: new Promise(() => {}), kill: () => {} };
  }
  async inspect(runId: string): Promise<NativeWorkerState> {
    return this.cold.has(runId) ? { state: "running" } : { state: "missing" };
  }
  async kill(runId: string) {
    this.cold.delete(runId);
  }
  async remove(runId: string) {
    this.cold.delete(runId);
  }
  async listWorkers() {
    return [];
  }
  async removeByWorkerName() {}
}

describe.skipIf(!process.env.DATABASE_URL)("PooledWorkerLauncher (database)", () => {
  const db = createPrismaClient();
  const ledger = new PrismaWarmPoolLedger(db);
  const tag = randomUUID().slice(0, 8);
  const agentId = `wp-agent-${tag}`;
  let counter = 0;
  const newToken = () => `${tag}${String((counter += 1)).padStart(12, "0")}`;
  const pools: PooledWorkerLauncher[] = [];

  beforeAll(async () => {
    await db.agent.create({ data: { id: agentId, name: agentId, systemPrompt: "s", model: "m", budgetUsd: 1 } });
  });

  afterAll(async () => {
    for (const pool of pools) pool.stop();
    await db.nativeWarmWorker.deleteMany({ where: { id: { startsWith: tag } } });
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  function pool(size: number, launcher = new FakeLauncher(), extra: { now?: () => number } = {}) {
    // A spec unique to this pool keeps tests (and other suites' rows) apart.
    launcher.spec = `spec-${randomUUID()}`;
    const onDelivered = vi.fn(async () => {});
    const p = new PooledWorkerLauncher({
      ledger,
      launcher,
      size,
      maxAgeMs: 60_000,
      warmTimeoutMs: 10_000,
      onDelivered,
      newToken,
      sleep: async () => {},
      ...extra,
    });
    pools.push(p);
    return { pool: p, launcher, onDelivered };
  }

  const input = async (): Promise<WorkerInput> => {
    const run = await db.run.create({ data: { agentId, nativeExecutionMode: "sandbox" } });
    return {
      v: 1,
      runId: run.id,
      gateway: { url: "http://gw", capability: `cap-${run.id}` },
    } as unknown as WorkerInput;
  };
  const warmed = async (p: PooledWorkerLauncher) => {
    await p.tick();
    await p.settled();
  };

  it("fills the pool, hands a run a warm worker with its input only after the claim, then refills", async () => {
    const { pool: p, launcher, onDelivered } = pool(2);
    await warmed(p);
    expect(launcher.warm.size).toBe(2);
    expect([...launcher.warm.values()].every((w) => w.input === undefined)).toBe(true);
    const first = await input();
    await p.launch(first);
    expect(launcher.cold.size).toBe(0);
    const holder = [...launcher.warm.entries()].find(([, w]) => w.input?.runId === first.runId);
    expect(holder).toBeDefined();
    expect(onDelivered).toHaveBeenCalledWith(first.runId);
    expect(await p.inspect(first.runId)).toEqual({ state: "running" });
    await warmed(p);
    expect(await db.nativeWarmWorker.count({ where: { specHash: p.specHash, status: "idle" } })).toBe(2);
    // The run ends: its worker and row go; nothing of it is ever handed to another run.
    await p.remove(first.runId);
    expect(launcher.warm.has(holder![0])).toBe(false);
    expect(await ledger.forRun(first.runId)).toBeNull();
  });

  it("gives concurrent runs distinct workers, and cold-launches the rest", async () => {
    const { pool: p, launcher } = pool(3);
    await warmed(p);
    const inputs = await Promise.all(Array.from({ length: 7 }, input));
    await Promise.all(inputs.map((i) => p.launch(i)));
    const delivered = [...launcher.warm.values()].filter((w) => w.input).map((w) => w.input!.runId);
    expect(delivered).toHaveLength(3);
    expect(new Set(delivered).size).toBe(3);
    expect(launcher.cold.size).toBe(4);
    expect(delivered.some((runId) => launcher.cold.has(runId))).toBe(false);
  });

  it("falls back cold, before delivering anything, when the claimed worker fails re-attest", async () => {
    const { pool: p, launcher } = pool(1);
    await warmed(p);
    launcher.intact = false;
    const run = await input();
    await p.launch(run);
    expect(launcher.cold.has(run.runId)).toBe(true);
    expect([...launcher.warm.values()].some((w) => w.input)).toBe(false);
    expect(await ledger.forRun(run.runId)).toBeNull();
  });

  it("after a failed delivery, cold-launches only once the worker is confirmed gone", async () => {
    const { pool: p, launcher } = pool(1);
    await warmed(p);
    launcher.failDeliver = true;
    const run = await input();
    await p.launch(run);
    expect(launcher.cold.has(run.runId)).toBe(true);
    expect([...launcher.warm.values()].some((w) => w.input?.runId === run.runId)).toBe(false);

    const stuck = pool(1);
    await warmed(stuck.pool);
    stuck.launcher.failDeliver = true;
    stuck.launcher.removeLeaves = true;
    let clock = 0;
    const timed = new PooledWorkerLauncher({
      ledger,
      launcher: stuck.launcher,
      size: 1,
      maxAgeMs: 60_000,
      warmTimeoutMs: 10_000,
      newToken,
      now: () => (clock += 10_000) + Date.now(),
      sleep: async () => {},
    });
    const other = await input();
    // The clock jumps 10 s per read, so the claim's age cutoff is pushed back by the same.
    await expect(timed.launch(other)).rejects.toThrow(/native_sandbox_warm_delivery_failed/);
    expect(stuck.launcher.cold.has(other.runId)).toBe(false);
  });

  it("retires stale, other-spec, gone, and excess idle workers, and reaps orphans and finished claims", async () => {
    const { pool: p, launcher } = pool(1);
    await warmed(p);
    const [kept] = launcher.warm.keys();
    // An orphan: a worker with no row.
    launcher.warm.set("ffffffffffffffffffff", { state: "running" });
    // An idle row whose worker is gone.
    const goneRow = (await ledger.reserve(p.specHash, 2, newToken, (t) => `wardby-nwarm-${t}`))[0];
    await ledger.markIdle(goneRow.id);
    await p.tick();
    await p.settled();
    expect(launcher.warm.has("ffffffffffffffffffff")).toBe(false);
    expect(await db.nativeWarmWorker.findUnique({ where: { id: goneRow.id } })).toBeNull();
    expect(launcher.warm.has(kept)).toBe(true);
    // A claim whose run has ended.
    const run = await input();
    await p.launch(run);
    await db.run.update({ where: { id: run.runId }, data: { status: "succeeded" } });
    await p.tick();
    await p.settled();
    expect(await ledger.forRun(run.runId)).toBeNull();
    // Lowering the size to 0 retires every idle worker.
    const shrink = new PooledWorkerLauncher({
      ledger,
      launcher,
      size: 0,
      maxAgeMs: 60_000,
      warmTimeoutMs: 10_000,
      newToken,
    });
    pools.push(shrink);
    await shrink.start();
    shrink.stop();
    expect(await db.nativeWarmWorker.count({ where: { specHash: p.specHash } })).toBe(0);
    expect(launcher.warm.size).toBe(0);
  });

  it("at size 0, keeps retiring workers another replica refills (a rolling update from a bigger size)", async () => {
    const launcher = new FakeLauncher();
    const { pool: other } = pool(2, launcher);
    await warmed(other);
    expect(launcher.warm.size).toBe(2);
    const shrunk = new PooledWorkerLauncher({
      ledger,
      launcher,
      size: 0,
      maxAgeMs: 60_000,
      warmTimeoutMs: 10_000,
      newToken,
      intervalMs: 20,
    });
    pools.push(shrunk);
    await shrunk.start();
    expect(launcher.warm.size).toBe(0);
    // The old replica, still running at size 2, refills after the new one's start-up pass.
    await warmed(other);
    expect(launcher.warm.size).toBe(2);
    await vi.waitFor(() => expect(launcher.warm.size).toBe(0), { timeout: 2_000, interval: 20 });
    expect(await db.nativeWarmWorker.count({ where: { specHash: other.specHash } })).toBe(0);
    // A live pool passes over every row: stop it before other tests run.
    shrunk.stop();
  });

  it("leaves another configuration's fresh idle worker alone, and retires it after the grace", async () => {
    const launcher = new FakeLauncher();
    const { pool: before } = pool(1, launcher);
    await warmed(before);
    const [old] = launcher.warm.keys();
    let offset = 0;
    // The same launcher under a new configuration (another image, say): another spec.
    const { pool: after } = pool(1, launcher, { now: () => Date.now() + offset });
    expect(after.specHash).not.toBe(before.specHash);
    await warmed(after);
    expect(launcher.warm.has(old)).toBe(true);
    offset = 61_000;
    await warmed(after);
    expect(launcher.warm.has(old)).toBe(false);
    expect(await db.nativeWarmWorker.count({ where: { specHash: before.specHash } })).toBe(0);
  });

  it("never claims a worker past the max age, and replaces it", async () => {
    let offset = 0;
    const { pool: p, launcher } = pool(1, new FakeLauncher(), { now: () => Date.now() + offset });
    await warmed(p);
    const [old] = launcher.warm.keys();
    offset = 61_000;
    const run = await input();
    await p.launch(run);
    expect(launcher.cold.has(run.runId)).toBe(true);
    await p.tick();
    await p.settled();
    expect(launcher.warm.has(old)).toBe(false);
  });

  it("leaves a warming row alone while this process is still starting it", async () => {
    const launcher = new FakeLauncher();
    let release!: () => void;
    launcher.startWarm = (token) =>
      new Promise<void>((resolve) => {
        release = () => {
          launcher.warm.set(token, { state: "running" });
          resolve();
        };
      });
    let offset = 0;
    const { pool: p } = pool(1, launcher, { now: () => Date.now() + offset });
    await p.tick();
    offset = 10 * 60_000;
    await p.tick();
    expect(await db.nativeWarmWorker.count({ where: { specHash: p.specHash, status: "warming" } })).toBe(1);
    release();
    await p.settled();
    expect(await db.nativeWarmWorker.count({ where: { specHash: p.specHash, status: "idle" } })).toBe(1);
  });

  it("drops a row whose worker could not start", async () => {
    const launcher = new FakeLauncher();
    launcher.failStart = true;
    const { pool: p } = pool(2, launcher);
    await warmed(p);
    expect(await db.nativeWarmWorker.count({ where: { specHash: p.specHash } })).toBe(0);
  });
});
