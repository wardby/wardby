import { describe, expect, it } from "vitest";
import {
  CODING_HOLD_GRACE_SEC,
  HOLD_HEARTBEAT_TTL_MS,
  computeGroupSpend,
  computeRunTreeSpend,
  effectiveBudgetForRun,
  periodStart,
  type BudgetGroupsDb,
} from "./budget-groups.js";

describe("periodStart", () => {
  it("day: truncates to UTC midnight", () => {
    expect(periodStart("day", new Date("2026-09-07T15:42:31.123Z"))).toEqual(new Date("2026-09-07T00:00:00.000Z"));
  });

  it("month: truncates to the 1st of the UTC month", () => {
    expect(periodStart("month", new Date("2026-09-07T15:42:31.123Z"))).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });

  it("week: truncates to the most recent UTC Monday 00:00 (mid-week)", () => {
    // 2026-09-09 is a Wednesday.
    expect(periodStart("week", new Date("2026-09-09T15:42:31.123Z"))).toEqual(new Date("2026-09-07T00:00:00.000Z"));
  });

  it("week: a UTC Monday truncates to itself", () => {
    expect(periodStart("week", new Date("2026-09-07T00:00:00.001Z"))).toEqual(new Date("2026-09-07T00:00:00.000Z"));
  });

  it("week: a UTC Sunday truncates to the Monday before it", () => {
    // 2026-09-13 is a Sunday; the ISO week's Monday is 2026-09-07.
    expect(periodStart("week", new Date("2026-09-13T23:59:59.000Z"))).toEqual(new Date("2026-09-07T00:00:00.000Z"));
  });
});

interface FakeRun {
  id?: string;
  agentId: string;
  costUsd: number;
  startedAt: Date;
  parentRunId?: string | null;
  /** Defaults to a finished run. */
  status?: string;
  /** Defaults to NOW: a live run. */
  heartbeatAt?: Date | null;
  codingRun?: { budgetReservedUsd: number; timeoutSec?: number } | null;
}
interface FakeGroup {
  id: string;
  name: string;
  dailyBudgetUsd: number | null;
  weeklyBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
  warnThresholdRatio: number;
  agentIds: string[];
}
interface FakeAgent {
  id: string;
  budgetGroupId: string | null;
  budgetUsd: number;
}

function fakeDb(groups: FakeGroup[], runs: FakeRun[], agents: FakeAgent[] = []): BudgetGroupsDb {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const withDefaults = runs.map((r) => ({
    status: "succeeded",
    heartbeatAt: NOW,
    ...r,
    codingRun: r.codingRun ? { timeoutSec: 1800, ...r.codingRun } : null,
  }));
  const runsById = new Map(withDefaults.filter((r) => r.id).map((r) => [r.id!, r]));
  return {
    budgetGroup: {
      findUnique: (async ({ where }: { where: { id: string } }) => {
        const g = byId.get(where.id);
        if (!g) return null;
        return { ...g, agents: g.agentIds.map((id) => ({ id, budgetUsd: agentsById.get(id)?.budgetUsd ?? 0 })) };
      }) as never,
    },
    agent: {
      findUniqueOrThrow: (async ({ where }: { where: { id: string } }) => {
        const a = agentsById.get(where.id);
        if (!a) throw new Error(`fakeDb: no agent "${where.id}"`);
        return a;
      }) as never,
    },
    run: {
      findUniqueOrThrow: (async ({ where }: { where: { id: string } }) => {
        const r = runsById.get(where.id);
        if (!r) throw new Error(`fakeDb: no run "${where.id}"`);
        return r;
      }) as never,
      findMany: (async (opts: {
        where: {
          agentId?: { in: string[] };
          startedAt?: { gte: Date };
          parentRunId?: { in: string[] };
          id?: { in: string[] };
        };
      }) => {
        const { where } = opts;
        if (where.agentId) {
          return withDefaults.filter(
            (r) => where.agentId!.in.includes(r.agentId) && r.startedAt >= where.startedAt!.gte,
          );
        }
        if (where.parentRunId) {
          return withDefaults.filter(
            (r) => r.parentRunId !== undefined && where.parentRunId!.in.includes(r.parentRunId as string),
          );
        }
        if (where.id) {
          return withDefaults.filter((r) => r.id && where.id!.in.includes(r.id));
        }
        return [];
      }) as never,
    },
  } as unknown as BudgetGroupsDb;
}

const NOW = new Date("2026-09-09T12:00:00.000Z"); // a Wednesday
const TODAY_START = new Date("2026-09-09T00:00:00.000Z");
const LATER = new Date("2026-09-09T00:00:01.000Z");

describe("computeGroupSpend", () => {
  it("returns nothing when the group has no caps configured", async () => {
    const db = fakeDb([], []);
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: null, weeklyBudgetUsd: null, monthlyBudgetUsd: null },
      [{ id: "a1", budgetUsd: 5 }],
      NOW,
    );
    expect(spend).toEqual([]);
  });

  it("sums only runs within each configured period's window, per agent in the group", async () => {
    const db = fakeDb(
      [],
      [
        { agentId: "a1", costUsd: 1, startedAt: TODAY_START }, // in today
        { agentId: "a2", costUsd: 2, startedAt: TODAY_START }, // in today, other member
        { agentId: "a1", costUsd: 5, startedAt: new Date("2026-09-01T00:00:00.000Z") }, // this month, not today
        { agentId: "a1", costUsd: 100, startedAt: new Date("2026-08-01T00:00:00.000Z") }, // outside the month entirely
      ],
    );
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: 10, weeklyBudgetUsd: null, monthlyBudgetUsd: 20 } as never,
      [
        { id: "a1", budgetUsd: 5 },
        { id: "a2", budgetUsd: 5 },
      ],
      NOW,
    );
    const byPeriod = Object.fromEntries(spend.map((s) => [s.period, s]));
    expect(byPeriod.day).toEqual({ period: "day", capUsd: 10, spentUsd: 3, reservedUsd: 0, remainingUsd: 7 });
    expect(byPeriod.month).toEqual({ period: "month", capUsd: 20, spentUsd: 8, reservedUsd: 0, remainingUsd: 12 });
    expect(byPeriod.week).toBeUndefined();
  });

  it("clamps remainingUsd at 0 when spend has already exceeded the cap", async () => {
    const db = fakeDb([], [{ agentId: "a1", costUsd: 15, startedAt: TODAY_START }]);
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: 10, weeklyBudgetUsd: null, monthlyBudgetUsd: null } as never,
      [{ id: "a1", budgetUsd: 5 }],
      NOW,
    );
    expect(spend[0]).toEqual({ period: "day", capUsd: 10, spentUsd: 15, reservedUsd: 0, remainingUsd: 0 });
  });

  it("E-04: counts every in-flight run's unspent reservation, native and coding, clamped at zero", async () => {
    const db = fakeDb(
      [],
      [
        // Native, running: holds its agent's $4 per-run budget, $1 spent -> $3 reserved.
        { id: "n1", agentId: "native", costUsd: 1, startedAt: TODAY_START, status: "running" },
        // Native, pending: nothing spent yet -> the full $4.
        { id: "n2", agentId: "native", costUsd: 0, startedAt: TODAY_START, status: "pending" },
        // Coding, running: holds what dispatch reserved ($2), $0.50 spent -> $1.50.
        {
          id: "c1",
          agentId: "coder",
          costUsd: 0.5,
          startedAt: TODAY_START,
          status: "running",
          codingRun: { budgetReservedUsd: 2 },
        },
        // Coding, already over its reservation: reserves nothing more, never negative.
        {
          id: "c2",
          agentId: "coder",
          costUsd: 2.5,
          startedAt: TODAY_START,
          status: "running",
          codingRun: { budgetReservedUsd: 2 },
        },
        // Finished: only its real cost counts.
        { id: "f1", agentId: "native", costUsd: 1, startedAt: TODAY_START, status: "succeeded" },
      ],
    );
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: 20, weeklyBudgetUsd: null, monthlyBudgetUsd: null } as never,
      [
        { id: "native", budgetUsd: 4 },
        { id: "coder", budgetUsd: 9 },
      ],
      NOW,
    );
    expect(spend[0]).toEqual({ period: "day", capUsd: 20, spentUsd: 5, reservedUsd: 8.5, remainingUsd: 6.5 });
  });

  it("E-04: leaves out the reservations of excluded runs but still counts their real cost", async () => {
    const db = fakeDb([], [{ id: "self", agentId: "native", costUsd: 1, startedAt: TODAY_START, status: "running" }]);
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: 10, weeklyBudgetUsd: null, monthlyBudgetUsd: null } as never,
      [{ id: "native", budgetUsd: 4 }],
      NOW,
      { excludeReservationRunIds: ["self"] },
    );
    expect(spend[0]).toEqual({ period: "day", capUsd: 10, spentUsd: 1, reservedUsd: 0, remainingUsd: 9 });
  });
});

describe("hold liveness (I2) and first come, first served (I3)", () => {
  const cap = { dailyBudgetUsd: 20, weeklyBudgetUsd: null, monthlyBudgetUsd: null } as never;
  const members = [
    { id: "native", budgetUsd: 4 },
    { id: "coder", budgetUsd: 9 },
  ];
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  it("a native run that stopped heartbeating releases its hold; one that still beats keeps it", async () => {
    const db = fakeDb(
      [],
      [
        {
          id: "zombie",
          agentId: "native",
          costUsd: 1,
          startedAt: TODAY_START,
          status: "running",
          heartbeatAt: ago(HOLD_HEARTBEAT_TTL_MS + 1),
        },
        {
          id: "alive",
          agentId: "native",
          costUsd: 1,
          startedAt: TODAY_START,
          status: "running",
          heartbeatAt: ago(5_000),
        },
        { id: "unbeaten", agentId: "native", costUsd: 0, startedAt: TODAY_START, status: "pending", heartbeatAt: null },
      ],
    );
    const [day] = await computeGroupSpend(db, cap, members, NOW);
    // Only "alive" holds: $4 - $1. Every row's real cost still counts.
    expect(day).toMatchObject({ spentUsd: 2, reservedUsd: 3, remainingUsd: 15 });
  });

  it("a queued coding run holds until its queue + run timeout pass, beat or not", async () => {
    const coding = (id: string, startedAt: Date) => ({
      id,
      agentId: "coder",
      costUsd: 0,
      startedAt,
      status: "pending",
      heartbeatAt: null,
      codingRun: { budgetReservedUsd: 2, timeoutSec: 600 },
    });
    // With a 100s queue timeout a run lapses (100 + 600 + grace) = 760s after dispatch.
    expect(100 + 600 + CODING_HOLD_GRACE_SEC).toBe(760);
    const db = fakeDb([], [coding("queued", ago(500_000)), coding("expired", ago(800_000))]);
    const [day] = await computeGroupSpend(db, cap, members, NOW, { codingQueueTimeoutSec: 100 });
    expect(day.reservedUsd).toBe(2);
    const [longQueue] = await computeGroupSpend(db, cap, members, NOW, { codingQueueTimeoutSec: 1_000 });
    expect(longQueue.reservedUsd).toBe(4);
  });

  it("holdsBefore counts only runs ordered earlier by (startedAt, id)", async () => {
    const db = fakeDb(
      [],
      [
        { id: "a", agentId: "native", costUsd: 0, startedAt: TODAY_START, status: "pending" },
        { id: "b", agentId: "native", costUsd: 0, startedAt: TODAY_START, status: "pending" },
        { id: "c", agentId: "native", costUsd: 0, startedAt: LATER, status: "pending" },
      ],
    );
    const held = async (self: { id: string; startedAt: Date }) =>
      (await computeGroupSpend(db, cap, members, NOW, { excludeReservationRunIds: [self.id], holdsBefore: self }))[0]
        .reservedUsd;
    expect(await held({ id: "a", startedAt: TODAY_START })).toBe(0);
    expect(await held({ id: "b", startedAt: TODAY_START })).toBe(4);
    expect(await held({ id: "c", startedAt: LATER })).toBe(8);
  });

  it("two cap-sized members dispatched together: exactly one gets the budget", async () => {
    const group = {
      id: "g1",
      name: "g",
      dailyBudgetUsd: 5,
      weeklyBudgetUsd: null,
      monthlyBudgetUsd: null,
      warnThresholdRatio: 0.8,
      agentIds: ["a1", "a2"],
    };
    const agents = [
      { id: "a1", budgetGroupId: "g1", budgetUsd: 5 },
      { id: "a2", budgetGroupId: "g1", budgetUsd: 5 },
    ];
    const db = fakeDb(
      [group],
      [
        { id: "r1", agentId: "a1", costUsd: 0, startedAt: TODAY_START, status: "pending" },
        { id: "r2", agentId: "a2", costUsd: 0, startedAt: TODAY_START, status: "pending" },
      ],
      agents,
    );
    const first = await effectiveBudgetForRun(db, agents[0] as never, NOW, undefined, {
      self: { id: "r1", startedAt: TODAY_START },
    });
    const second = await effectiveBudgetForRun(db, agents[1] as never, NOW, undefined, {
      self: { id: "r2", startedAt: TODAY_START },
    });
    expect(first.effectiveBudgetUsd).toBe(5);
    expect(second.effectiveBudgetUsd).toBe(0);
  });
});

describe("effectiveBudgetForRun", () => {
  it("returns the agent's own budgetUsd unchanged when it has no budgetGroupId", async () => {
    const db = fakeDb([], []);
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: null, budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 5, constrainedBy: [] });
  });

  it("returns the agent's own budgetUsd unchanged when its group has no caps set", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: null,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agentIds: ["a1"],
        },
      ],
      [],
    );
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 5, constrainedBy: [] });
  });

  it("tightens the effective budget to the group's remaining daily cap when that's smaller than budgetUsd", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: 10,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agentIds: ["a1"],
        },
      ],
      [{ agentId: "a1", costUsd: 8, startedAt: TODAY_START }],
    );
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 2, constrainedBy: ["day"] });
  });

  it("returns an effective budget of 0 once the group's period cap is fully spent — the engine's existing zero-budget refuse then applies", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: 10,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agentIds: ["a1"],
        },
      ],
      [{ agentId: "a1", costUsd: 10, startedAt: TODAY_START }],
    );
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never, NOW);
    expect(result.effectiveBudgetUsd).toBe(0);
    expect(result.exhaustedBy).toBe("day");
  });

  it("E-04: another member's in-flight reservation tightens the budget; the run's own (self) does not", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: 10,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agentIds: ["a1", "a2"],
        },
      ],
      [
        { id: "other", agentId: "a2", costUsd: 0, startedAt: TODAY_START, status: "running" },
        { id: "self", agentId: "a1", costUsd: 0, startedAt: TODAY_START, status: "running" },
      ],
      [
        { id: "a1", budgetGroupId: "g1", budgetUsd: 5 },
        { id: "a2", budgetGroupId: "g1", budgetUsd: 7 },
      ],
    );
    const result = await effectiveBudgetForRun(
      db,
      { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never,
      NOW,
      undefined,
      { self: { id: "self", startedAt: TODAY_START } },
    );
    // $10 cap - a2's $7 held by its in-flight run = $3; a1's own run is not counted against itself.
    expect(result).toEqual({ effectiveBudgetUsd: 3, constrainedBy: ["day"] });
  });

  it("uses the tightest of multiple configured periods, not just the first one checked", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: 10,
          weeklyBudgetUsd: 12,
          monthlyBudgetUsd: 100,
          warnThresholdRatio: 0.8,
          agentIds: ["a1"],
        },
      ],
      [
        { agentId: "a1", costUsd: 2, startedAt: TODAY_START }, // daily remaining: 8
        { agentId: "a1", costUsd: 9, startedAt: new Date("2026-09-07T00:00:00.000Z") }, // this ISO week (Mon 09-07) too -> weekly spend 11, remaining 1
      ],
    );
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never, NOW);
    expect(result.effectiveBudgetUsd).toBe(1);
    expect(result.constrainedBy).toContain("week");
  });
});

describe("computeRunTreeSpend", () => {
  it("for a top-level run with no children yet, remaining is the root agent's own ceiling minus its own spend", async () => {
    const db = fakeDb(
      [],
      [{ id: "run-root", agentId: "root-agent", costUsd: 3, startedAt: TODAY_START, parentRunId: null }],
      [{ id: "root-agent", budgetGroupId: null, budgetUsd: 10 }],
    );
    const tree = await computeRunTreeSpend(db, "run-root", NOW);
    expect(tree).toEqual({ rootRunId: "run-root", capUsd: 10, spentUsd: 3, remainingUsd: 7 });
  });

  it("walks up past an intermediate parent to the true root, and sums every run already in the tree", async () => {
    const db = fakeDb(
      [],
      [
        { id: "run-root", agentId: "root-agent", costUsd: 3, startedAt: TODAY_START, parentRunId: null },
        { id: "run-child", agentId: "child-agent", costUsd: 2, startedAt: TODAY_START, parentRunId: "run-root" },
      ],
      [{ id: "root-agent", budgetGroupId: null, budgetUsd: 10 }],
    );
    // Asking on behalf of run-child (as if it were about to dispatch a grandchild).
    const tree = await computeRunTreeSpend(db, "run-child", NOW);
    expect(tree).toEqual({ rootRunId: "run-root", capUsd: 10, spentUsd: 5, remainingUsd: 5 });
  });

  it("the root's own ceiling is itself tightened by the root agent's BudgetGroup, not just its raw budgetUsd", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: 6,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agentIds: ["root-agent"],
        },
      ],
      [{ id: "run-root", agentId: "root-agent", costUsd: 1, startedAt: TODAY_START, parentRunId: null }],
      [{ id: "root-agent", budgetGroupId: "g1", budgetUsd: 10 }],
    );
    // root's own ceiling: min(10, 6-1=5) = 5; tree has only spent the root's own $1 so far.
    const tree = await computeRunTreeSpend(db, "run-root", NOW);
    expect(tree).toEqual({ rootRunId: "run-root", capUsd: 5, spentUsd: 1, remainingUsd: 4 });
  });

  it("E-04: the tree's own in-flight reservations don't shrink its ceiling; another member's do", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: 10,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agentIds: ["root-agent", "other-agent"],
        },
      ],
      [
        { id: "run-root", agentId: "root-agent", costUsd: 1, startedAt: LATER, status: "running" },
        { id: "run-other", agentId: "other-agent", costUsd: 0, startedAt: TODAY_START, status: "pending" },
      ],
      [
        { id: "root-agent", budgetGroupId: "g1", budgetUsd: 6 },
        { id: "other-agent", budgetGroupId: "g1", budgetUsd: 5 },
      ],
    );
    // Root ceiling: min(6, 10 - $1 spent - other's $5 held, it started first) = 4; the tree has spent $1.
    const tree = await computeRunTreeSpend(db, "run-root", NOW);
    expect(tree).toEqual({ rootRunId: "run-root", capUsd: 4, spentUsd: 1, remainingUsd: 3 });
  });
});

describe("effectiveBudgetForRun with parentRunId (sub-agent dispatch)", () => {
  it("composes the run-tree ceiling with the dispatched child's own budgetUsd — the tighter one wins", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: 6,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agentIds: ["root-agent"],
        },
      ],
      [{ id: "run-root", agentId: "root-agent", costUsd: 1, startedAt: TODAY_START, parentRunId: null }],
      [
        { id: "root-agent", budgetGroupId: "g1", budgetUsd: 10 },
        { id: "child-agent", budgetGroupId: null, budgetUsd: 100 },
      ],
    );
    // Root's own ceiling is min(10, 6-1=5) = 5, minus its own $1 spent = 4 remaining for the tree.
    // The dispatched child's own budgetUsd (100) is far looser, so the tree ceiling wins.
    const result = await effectiveBudgetForRun(
      db,
      { id: "child-agent", budgetGroupId: null, budgetUsd: 100 } as never,
      NOW,
      "run-root",
    );
    expect(result).toEqual({ effectiveBudgetUsd: 4, constrainedBy: ["run-tree"] });
  });

  it("M1: a child in a different group than the root counts the tree's holds in its own group", async () => {
    const g2 = {
      id: "g2",
      name: "g2",
      dailyBudgetUsd: 10,
      weeklyBudgetUsd: null,
      monthlyBudgetUsd: null,
      warnThresholdRatio: 0.8,
      agentIds: ["mid-agent", "leaf-agent"],
    };
    const db = fakeDb(
      [g2],
      [
        { id: "run-root", agentId: "root-agent", costUsd: 0, startedAt: TODAY_START, status: "running" },
        {
          id: "run-mid",
          agentId: "mid-agent",
          costUsd: 0,
          startedAt: LATER,
          status: "running",
          parentRunId: "run-root",
        },
      ],
      [
        { id: "root-agent", budgetGroupId: null, budgetUsd: 100 },
        { id: "mid-agent", budgetGroupId: "g2", budgetUsd: 7 },
        { id: "leaf-agent", budgetGroupId: "g2", budgetUsd: 9 },
      ],
    );
    // The root is ungrouped, so the mid run's $7 hold in g2 is not covered by
    // any hold the root made there: the leaf sees $10 - $7 = $3.
    const result = await effectiveBudgetForRun(
      db,
      { id: "leaf-agent", budgetGroupId: "g2", budgetUsd: 9 } as never,
      NOW,
      "run-mid",
    );
    expect(result.effectiveBudgetUsd).toBe(3);
    expect(result.constrainedBy).toEqual(["day"]);
  });

  it("reports run-tree as the exhausted constraint once the tree's ceiling is spent", async () => {
    const db = fakeDb(
      [],
      [{ id: "run-root", agentId: "root-agent", costUsd: 2, startedAt: TODAY_START, status: "running" }],
      [{ id: "root-agent", budgetGroupId: null, budgetUsd: 2 }],
    );
    const result = await effectiveBudgetForRun(
      db,
      { id: "child-agent", budgetGroupId: null, budgetUsd: 5 } as never,
      NOW,
      "run-root",
    );
    expect(result).toEqual({ effectiveBudgetUsd: 0, constrainedBy: ["run-tree"], exhaustedBy: "run-tree" });
  });

  it("a top-level run (no parentRunId) is unaffected by run-tree logic entirely", async () => {
    const db = fakeDb([], []);
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: null, budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 5, constrainedBy: [] });
  });
});
