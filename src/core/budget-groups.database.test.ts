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
    expect(await db.runBudgetEvent.findMany({ where: { runId: run.id } })).toEqual([
      expect.objectContaining({
        kind: "refused",
        limit: "day",
        details: expect.objectContaining({ source: "dispatch", heldRuns: expect.any(Number) }),
      }),
    ]);
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
    // The group's remainder, not the agent's own budget, bound this reservation.
    const coding = await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } });
    expect(coding.budgetLimitedBy).toBe("day");
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
    // Ctrl-C'd an hour ago: still "running", no beat since. The clock is pinned to midday UTC so
    // "an hour ago" is always inside the group's daily window; with the real clock, between 00:00 and
    // 01:00 UTC the zombie would fall into yesterday and not count at all.
    const today = new Date();
    const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12));
    const stale = new Date(now.getTime() - 60 * 60 * 1000);
    const zombie = await db.run.create({
      data: { agentId: native, status: "running", costUsd: 0.5, startedAt: stale, heartbeatAt: stale },
    });

    const result = await dispatchRun({ db, executor, agentId: coder, now });

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
    expect(await db.runBudgetEvent.findMany({ where: { runId: refused.id } })).toEqual([
      expect.objectContaining({
        kind: "refused",
        limit: "run-tree",
        details: expect.objectContaining({ source: "dispatch", heldRuns: 0 }),
      }),
    ]);

    await db.run.update({ where: { id: parent.id }, data: { status: "succeeded", finishedAt: new Date() } });
  });

  it("sub-agent: a running root whose group is the binding limit leaves its coding child the true remainder", async () => {
    const g = await group("tree-bind", 5);
    const parentAgent = await nativeAgent("tree-bind-parent", 10, g);
    const child = await codingAgent("tree-bind-child", 10, g);
    // The root is mid-run and has spent $2 live; its group's $5 daily cap binds, not its own $10.
    const parent = await db.run.create({ data: { agentId: parentAgent, status: "running", costUsd: 2 } });

    const result = await dispatchRun({ db, executor, agentId: child, trigger: "subagent", parentRunId: parent.id });

    // $5 - $2 = $3, with the root's $2 counted once.
    expect(await reservedUsd(result!.run.id)).toBeCloseTo(3, 6);

    await db.run.updateMany({
      where: { id: { in: [parent.id, result!.run.id] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("a delegated tree is held once: a lead and its child leave the rest of the group its true headroom", async () => {
    const g = await db.budgetGroup.create({
      data: { id: id("tree-once"), name: id("tree-once"), ownerId: owner, weeklyBudgetUsd: 25 },
    });
    const lead = await nativeAgent("once-lead", 21, g.id);
    const builder = await codingAgent("once-builder", 20, g.id);
    const other = await codingAgent("once-other", 4, g.id);
    const parent = await db.run.create({ data: { agentId: lead, status: "running", costUsd: 1 } });
    const child = await dispatchRun({ db, executor, agentId: builder, trigger: "subagent", parentRunId: parent.id });

    // The tree holds $21 - $1 = $20 once, not the lead's $20 and the child's $20 separately.
    const result = await dispatchRun({ db, executor, agentId: other });
    const run = result!.run;
    expect(run.status).not.toBe("refused");
    expect(await reservedUsd(run.id)).toBeCloseTo(4, 6);

    await db.run.updateMany({
      where: { id: { in: [parent.id, child!.run.id, run.id] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("B2: a delegated coding child reserves only its base, so a run started between the lead and it never takes the group past its cap", async () => {
    const g = await group("tree-overrun", 20);
    const lead = id("overrun-lead");
    await db.agent.create({
      data: {
        id: lead,
        name: lead,
        systemPrompt: "t",
        model: "t",
        budgetUsd: 10,
        allowedOverrunPercent: 50,
        ownerId: owner,
        budgetGroupId: g,
      },
    });
    const builder = await codingAgent("overrun-builder", 10, g);
    await db.agent.update({ where: { id: builder }, data: { allowedOverrunPercent: 50 } });
    const other = await codingAgent("overrun-other", 10, g);
    const parent = await db.run.create({ data: { agentId: lead, status: "running", costUsd: 0 } });
    // Started after the lead, before its builder: first come, first served, the builder's dispatch does not see it.
    const result = await dispatchRun({ db, executor, agentId: other });
    const child = await dispatchRun({ db, executor, agentId: builder, trigger: "subagent", parentRunId: parent.id });

    // The builder reserves its $10 base out of the lead's $10; its overrun ($15 in all) is left to top-ups.
    const childReserved = (await reservedUsd(child!.run.id)) ?? 0;
    expect(childReserved).toBeCloseTo(10, 6);
    const otherReserved = (await reservedUsd(result!.run.id)) ?? 0;
    expect(otherReserved).toBeCloseTo(10, 6);
    expect(childReserved + otherReserved).toBeLessThanOrEqual(20 + 1e-6);

    await db.run.updateMany({
      where: { id: { in: [parent.id, child!.run.id, result!.run.id] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("a live native sibling beside an overrun coding child is held too, so the group never reserves past its cap", async () => {
    const g = await group("tree-mixed", 20);
    const lead = id("mixed-lead");
    await db.agent.create({
      data: {
        id: lead,
        name: lead,
        systemPrompt: "t",
        model: "t",
        budgetUsd: 10,
        allowedOverrunPercent: 50,
        ownerId: owner,
        budgetGroupId: g,
      },
    });
    const helper = await nativeAgent("mixed-helper", 5, g);
    const builder = await codingAgent("mixed-builder", 10, g);
    await db.agent.update({ where: { id: builder }, data: { allowedOverrunPercent: 50 } });
    const other = await codingAgent("mixed-other", 10, g);
    const parent = await db.run.create({ data: { agentId: lead, status: "running", costUsd: 0 } });
    const native = await db.run.create({
      data: { agentId: helper, status: "running", costUsd: 0, parentRunId: parent.id },
    });
    const child = await dispatchRun({ db, executor, agentId: builder, trigger: "subagent", parentRunId: parent.id });

    // The lead's $10 less the native sibling's $5 hold; the overrun is never reserved.
    const childReserved = (await reservedUsd(child!.run.id)) ?? 0;
    expect(childReserved).toBeCloseTo(5, 6);
    const result = await dispatchRun({ db, executor, agentId: other });
    // The tree holds $5 + $5 = $10, leaving $10.
    expect(await reservedUsd(result!.run.id)).toBeCloseTo(10, 6);

    await db.run.updateMany({
      where: { id: { in: [parent.id, native.id, child!.run.id, result!.run.id] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });

  it("parallel delegations: concurrent coding children of one parent never reserve more than the tree has left", async () => {
    const parentAgent = await nativeAgent("par-parent", 10, null);
    const children = await Promise.all([0, 1, 2, 3].map((i) => codingAgent(`par-child-${i}`, 4, null)));
    const parent = await db.run.create({ data: { agentId: parentAgent, status: "running", costUsd: 0 } });

    // Ungrouped agents take no BudgetGroup lock: the Serializable persist transaction's
    // retry is what keeps these four from each reading the same remainder. A barrier on
    // the first four persist attempts (after each has read the tree's budget) holds them
    // all open together, so they overlap for certain and at least one must retry.
    let persistAttempts = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve));
    const afterPersist = async () => {
      persistAttempts += 1;
      if (persistAttempts === children.length) releaseBarrier();
      if (persistAttempts <= children.length) {
        await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
    };
    const results = await Promise.all(
      children.map((agentId) =>
        dispatchRun({ db, executor, agentId, trigger: "subagent", parentRunId: parent.id, afterPersist }),
      ),
    );
    expect(persistAttempts).toBeGreaterThan(children.length);
    const reserved = (await Promise.all(results.map((r) => reservedUsd(r!.run.id)))).map((v) => v ?? 0);
    expect(reserved.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10 + 1e-6);
    expect([...reserved].sort((a, b) => a - b)).toEqual([0, 2, 4, 4]);
    const statuses = await db.run.findMany({
      where: { id: { in: results.map((r) => r!.run.id) } },
      select: { status: true, error: true },
    });
    expect(statuses.filter((s) => s.status === "refused").map((s) => s.error)).toEqual([
      expect.stringMatching(/^run_tree_exhausted\b/),
    ]);

    await db.run.updateMany({
      where: { id: { in: [parent.id, ...results.map((r) => r!.run.id)] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  });
});
