import { describe, expect, it } from "vitest";
import {
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
  const runsById = new Map(runs.filter((r) => r.id).map((r) => [r.id!, r]));
  return {
    budgetGroup: {
      findUnique: (async ({ where }: { where: { id: string } }) => {
        const g = byId.get(where.id);
        if (!g) return null;
        return { ...g, agents: g.agentIds.map((id) => ({ id })) };
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
          return runs.filter((r) => where.agentId!.in.includes(r.agentId) && r.startedAt >= where.startedAt!.gte);
        }
        if (where.parentRunId) {
          return runs.filter(
            (r) => r.parentRunId !== undefined && where.parentRunId!.in.includes(r.parentRunId as string),
          );
        }
        if (where.id) {
          return runs.filter((r) => r.id && where.id!.in.includes(r.id));
        }
        return [];
      }) as never,
    },
  } as unknown as BudgetGroupsDb;
}

const NOW = new Date("2026-09-09T12:00:00.000Z"); // a Wednesday
const TODAY_START = new Date("2026-09-09T00:00:00.000Z");

describe("computeGroupSpend", () => {
  it("returns nothing when the group has no caps configured", async () => {
    const db = fakeDb([], []);
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: null, weeklyBudgetUsd: null, monthlyBudgetUsd: null },
      ["a1"],
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
      ["a1", "a2"],
      NOW,
    );
    const byPeriod = Object.fromEntries(spend.map((s) => [s.period, s]));
    expect(byPeriod.day).toEqual({ period: "day", capUsd: 10, spentUsd: 3, remainingUsd: 7 });
    expect(byPeriod.month).toEqual({ period: "month", capUsd: 20, spentUsd: 8, remainingUsd: 12 });
    expect(byPeriod.week).toBeUndefined();
  });

  it("clamps remainingUsd at 0 when spend has already exceeded the cap", async () => {
    const db = fakeDb([], [{ agentId: "a1", costUsd: 15, startedAt: TODAY_START }]);
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: 10, weeklyBudgetUsd: null, monthlyBudgetUsd: null } as never,
      ["a1"],
      NOW,
    );
    expect(spend[0]).toEqual({ period: "day", capUsd: 10, spentUsd: 15, remainingUsd: 0 });
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

  it("a top-level run (no parentRunId) is unaffected by run-tree logic entirely", async () => {
    const db = fakeDb([], []);
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: null, budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 5, constrainedBy: [] });
  });
});
