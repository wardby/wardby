/**
 * Budget groups against real PostgreSQL (security review E-01, E-04): a
 * top-level coding run is capped by its agent's budget group at dispatch,
 * refused when the group has nothing left, and every in-flight run's unspent
 * reservation counts against the group, so concurrent dispatches cannot each
 * claim the same remainder.
 *
 * The coding runs created here are never claimed by an executor (no
 * jobBackend, no queuedAt), so they never hold a global coding slot or queue
 * position (see coding-concurrency.database.test.ts); each test still retires
 * its runs when done.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { createPrismaClient } from "./db.js";
import { dispatchRun } from "./dispatch.js";
import { effectiveBudgetForRun } from "./budget-groups.js";

describe.skipIf(!process.env.DATABASE_URL)("budget groups (database)", () => {
  const db = createPrismaClient();
  const PREFIX = "bgdb-";
  const suffix = randomUUID();
  const owner = `${PREFIX}owner-${suffix}`;
  const id = (name: string) => `${PREFIX}${name}-${suffix}`;
  const started: string[] = [];
  const executor: Executor = {
    async start(runId: string) {
      started.push(runId);
    },
    async stop() {},
  };

  async function group(name: string, dailyBudgetUsd: number): Promise<string> {
    const g = await db.budgetGroup.create({ data: { id: id(name), name: id(name), ownerId: owner, dailyBudgetUsd } });
    return g.id;
  }

  async function codingAgent(name: string, budgetUsd: number, budgetGroupId: string | null): Promise<string> {
    const agentId = id(name);
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Fix things.",
        model: "gpt-5.6-luna",
        budgetUsd,
        kind: "coding",
        ownerId: owner,
        budgetGroupId,
        codingProfile: {
          create: { provider: "codex", repository: "openai/example", defaultTask: "Fix it.", protectedPaths: [] },
        },
      },
    });
    return agentId;
  }

  async function nativeAgent(name: string, budgetUsd: number, budgetGroupId: string | null): Promise<string> {
    const agentId = id(name);
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd, ownerId: owner, budgetGroupId },
    });
    return agentId;
  }

  async function reservedUsd(runId: string): Promise<number | null> {
    const row = await db.codingRun.findUnique({ where: { runId }, select: { budgetReservedUsd: true } });
    return row ? Number(row.budgetReservedUsd) : null;
  }

  async function cleanup(): Promise<void> {
    const agents = { agentId: { startsWith: PREFIX } };
    await db.codingRun.deleteMany({ where: { run: agents } });
    // Children before parents (Run.parentRunId has no cascade).
    await db.run.deleteMany({ where: { ...agents, parentRunId: { not: null } } });
    await db.run.deleteMany({ where: agents });
    await db.codingAgentProfile.deleteMany({ where: agents });
    await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.budgetGroup.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.principal.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    await cleanup();
    await db.principal.create({ data: { id: owner, subject: owner } });
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("E-01: refuses a grouped coding run whose group cap is exhausted, naming the period", async () => {
    const g = await group("exhausted", 5);
    const spender = await nativeAgent("exhausted-spender", 10, g);
    await db.run.create({ data: { agentId: spender, status: "succeeded", costUsd: 5, finishedAt: new Date() } });
    const coder = await codingAgent("exhausted-coder", 2, g);

    const result = await dispatchRun({ db, executor, agentId: coder, trigger: "webhook" });

    expect(result).not.toBeNull();
    const run = await db.run.findUniqueOrThrow({ where: { id: result!.run.id } });
    expect(run.status).toBe("refused");
    expect(run.error).toMatch(/^budget_group_exhausted:day\b/);
    expect(run.finishedAt).not.toBeNull();
    expect(Number(run.costUsd)).toBe(0);
    expect(await reservedUsd(run.id)).toBeNull();
    expect(started).not.toContain(run.id);
  });

  it("E-01: a partially spent group caps the coding run's reservation", async () => {
    const g = await group("partial", 5);
    const spender = await nativeAgent("partial-spender", 10, g);
    await db.run.create({ data: { agentId: spender, status: "succeeded", costUsd: 4.25, finishedAt: new Date() } });
    const coder = await codingAgent("partial-coder", 2, g);

    const result = await dispatchRun({ db, executor, agentId: coder, trigger: "scheduled" });

    expect(result!.run.status).toBe("pending");
    expect(await reservedUsd(result!.run.id)).toBeCloseTo(0.75, 6);
    expect(started).toContain(result!.run.id);
  });

  it("an ungrouped coding run still reserves its own full budget", async () => {
    const coder = await codingAgent("ungrouped-coder", 2, null);
    const result = await dispatchRun({ db, executor, agentId: coder, trigger: "manual" });
    expect(await reservedUsd(result!.run.id)).toBe(2);
  });

  it("E-04: an in-flight run's unspent reservation counts against the group", async () => {
    const g = await group("inflight", 5);
    const first = await codingAgent("inflight-first", 3, g);
    const second = await codingAgent("inflight-second", 3, g);

    const a = await dispatchRun({ db, executor, agentId: first });
    expect(await reservedUsd(a!.run.id)).toBe(3);
    // The first run has spent $1 of its $3 so far: its unspent $2 is still held.
    await db.run.update({ where: { id: a!.run.id }, data: { status: "running", costUsd: 1 } });

    const b = await dispatchRun({ db, executor, agentId: second });
    expect(await reservedUsd(b!.run.id)).toBeCloseTo(5 - 1 - 2, 6);

    // Once the first run is terminal only its real spend counts.
    await db.run.update({ where: { id: a!.run.id }, data: { status: "succeeded", finishedAt: new Date() } });
    await db.run.update({ where: { id: b!.run.id }, data: { status: "cancelled", finishedAt: new Date() } });
    const c = await dispatchRun({ db, executor, agentId: second });
    expect(await reservedUsd(c!.run.id)).toBe(3);
    await db.run.update({ where: { id: c!.run.id }, data: { status: "cancelled", finishedAt: new Date() } });
  });

  it("E-04: an in-flight native run holds its agent's per-run budget, and a native run never counts itself", async () => {
    const g = await group("native", 5);
    const native = await nativeAgent("native-member", 4, g);
    const coder = await codingAgent("native-coder", 3, g);
    const nativeRun = await db.run.create({ data: { agentId: native, status: "running", costUsd: 0.5 } });

    // The native run's own load step sees the whole cap minus nothing else.
    const own = await effectiveBudgetForRun(
      db,
      await db.agent.findUniqueOrThrow({ where: { id: native } }),
      new Date(),
      undefined,
      { self: { id: nativeRun.id, startedAt: nativeRun.startedAt } },
    );
    expect(own.effectiveBudgetUsd).toBeCloseTo(4, 6);

    // A coding dispatch sees $0.50 spent and $3.50 still reserved by it.
    const result = await dispatchRun({ db, executor, agentId: coder });
    expect(await reservedUsd(result!.run.id)).toBeCloseTo(1, 6);

    await db.run.updateMany({
      where: { id: { in: [nativeRun.id, result!.run.id] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("E-04: two concurrent dispatches in one group cannot both claim the same remainder", async () => {
    const g = await group("race", 5);
    const agents = await Promise.all([codingAgent("race-a", 4, g), codingAgent("race-b", 4, g)]);

    const results = await Promise.all(agents.map((agentId) => dispatchRun({ db, executor, agentId })));

    const reserved = await Promise.all(results.map((r) => reservedUsd(r!.run.id)));
    const total = reserved.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    expect(total).toBeLessThanOrEqual(5 + 1e-9);
    expect(reserved.map((value) => value ?? 0).sort()).toEqual([1, 4]);

    await db.run.updateMany({
      where: { id: { in: results.map((r) => r!.run.id) } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("I1: a burst of 8 concurrent grouped coding dispatches all persist, and never reserve more than the cap", async () => {
    const g = await group("burst", 5);
    const agents = await Promise.all(Array.from({ length: 8 }, (_, i) => codingAgent(`burst-${i}`, 1, g)));

    const results = await Promise.all(agents.map((agentId) => dispatchRun({ db, executor, agentId })));

    const runs = await db.run.findMany({
      where: { id: { in: results.map((r) => r!.run.id) } },
      include: { codingRun: { select: { budgetReservedUsd: true } } },
    });
    expect(runs).toHaveLength(8);
    const reserved = runs.reduce((sum, r) => sum + Number(r.codingRun?.budgetReservedUsd ?? 0), 0);
    expect(reserved).toBeCloseTo(5, 6);
    expect(runs.filter((r) => r.status === "refused")).toHaveLength(3);
    for (const r of runs.filter((run) => run.status === "refused")) {
      expect(r.error).toMatch(/^budget_group_exhausted:day\b/);
    }

    await db.run.updateMany({
      where: { id: { in: runs.map((r) => r.id) }, status: "pending" },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("I2: a run that stopped heartbeating no longer holds budget against the group", async () => {
    const g = await group("zombie", 5);
    const native = await nativeAgent("zombie-native", 5, g);
    const coder = await codingAgent("zombie-coder", 5, g);
    // Ctrl-C'd an hour ago: still "running", no beat since.
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const zombie = await db.run.create({
      data: { agentId: native, status: "running", costUsd: 0.5, startedAt: stale, heartbeatAt: stale },
    });

    const result = await dispatchRun({ db, executor, agentId: coder });

    // Only the zombie's real $0.50 counts, not its $4.50 unspent hold.
    expect(await reservedUsd(result!.run.id)).toBeCloseTo(4.5, 6);
    await db.run.updateMany({
      where: { id: { in: [zombie.id, result!.run.id] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("I3: two cap-sized native members dispatched on the same tick: exactly one gets the budget", async () => {
    const g = await group("fcfs", 5);
    const [a, b] = await Promise.all([nativeAgent("fcfs-a", 5, g), nativeAgent("fcfs-b", 5, g)]);
    const tick = new Date();
    const [runA, runB] = await Promise.all([
      db.run.create({ data: { agentId: a, startedAt: tick, executionManaged: true } }),
      db.run.create({ data: { agentId: b, startedAt: tick, executionManaged: true } }),
    ]);

    // Both load steps at once, each seeing the other's pending row.
    const [budgetA, budgetB] = await Promise.all(
      [
        { agentId: a, run: runA },
        { agentId: b, run: runB },
      ].map(async ({ agentId, run }) =>
        effectiveBudgetForRun(db, await db.agent.findUniqueOrThrow({ where: { id: agentId } }), new Date(), undefined, {
          self: { id: run.id, startedAt: run.startedAt },
        }),
      ),
    );

    const budgets = [budgetA.effectiveBudgetUsd, budgetB.effectiveBudgetUsd].sort();
    expect(budgets).toEqual([0, 5]);
    await db.run.updateMany({
      where: { id: { in: [runA.id, runB.id] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("sub-agent: a coding child is capped by the run tree, and the tree's own reservations are not counted twice", async () => {
    const g = await group("tree", 10);
    const parentAgent = await nativeAgent("tree-parent", 3, g);
    const child = await codingAgent("tree-child", 5, g);
    // The parent is mid-run and has spent $1 of its tree ceiling ($3).
    const parent = await db.run.create({ data: { agentId: parentAgent, status: "running", costUsd: 1 } });

    const result = await dispatchRun({ db, executor, agentId: child, trigger: "subagent", parentRunId: parent.id });

    // Tree: $3 ceiling - $1 spent = $2. The group ($10 - $1 spent) would allow
    // more; the parent's own $2 unspent reservation must not shrink it further.
    expect(await reservedUsd(result!.run.id)).toBeCloseTo(2, 6);

    await db.run.update({ where: { id: result!.run.id }, data: { status: "succeeded", costUsd: 2 } });
    const again = await dispatchRun({ db, executor, agentId: child, trigger: "subagent", parentRunId: parent.id });
    const refused = await db.run.findUniqueOrThrow({ where: { id: again!.run.id } });
    expect(refused.status).toBe("refused");
    expect(refused.error).toMatch(/^run_tree_exhausted\b/);

    await db.run.update({ where: { id: parent.id }, data: { status: "succeeded", finishedAt: new Date() } });
  });
});
