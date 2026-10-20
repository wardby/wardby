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
import { fakeBudgetDb, type FakeAgent, type FakeGroup, type FakeRun } from "./budget-groups.test-support.js";

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

const fakeDb = (groups: FakeGroup[], runs: FakeRun[], agents: FakeAgent[] = []): BudgetGroupsDb =>
  fakeBudgetDb(groups, runs, agents, NOW);

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
    expect(byPeriod.day).toEqual({
      period: "day",
      capUsd: 10,
      spentUsd: 3,
      reservedUsd: 0,
      remainingUsd: 7,
      heldRuns: 0,
    });
    expect(byPeriod.month).toEqual({
      period: "month",
      capUsd: 20,
      spentUsd: 8,
      reservedUsd: 0,
      remainingUsd: 12,
      heldRuns: 0,
    });
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
    expect(spend[0]).toEqual({ period: "day", capUsd: 10, spentUsd: 15, reservedUsd: 0, remainingUsd: 0, heldRuns: 0 });
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
    expect(spend[0]).toEqual({
      period: "day",
      capUsd: 20,
      spentUsd: 5,
      reservedUsd: 8.5,
      remainingUsd: 6.5,
      heldRuns: 3,
    });
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
    expect(spend[0]).toEqual({ period: "day", capUsd: 10, spentUsd: 1, reservedUsd: 0, remainingUsd: 9, heldRuns: 0 });
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

describe("a delegated tree is held once", () => {
  const group = { dailyBudgetUsd: null, weeklyBudgetUsd: 25, monthlyBudgetUsd: null } as never;
  const members = [
    { id: "lead", budgetUsd: 21 },
    { id: "builder", budgetUsd: 20 },
    { id: "other", budgetUsd: 4 },
  ];

  it("lead running with a child: holds the lead's budget minus the tree's cost", async () => {
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 1, startedAt: NOW, status: "running" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 0,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 20 },
        },
      ],
    );
    const [week] = await computeGroupSpend(db, group, members, NOW);
    expect(week).toMatchObject({ spentUsd: 1, reservedUsd: 20, remainingUsd: 4, heldRuns: 1 });
  });

  it("child has spent $8: tree holds $12", async () => {
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 1, startedAt: NOW, status: "running" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 8,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 20 },
        },
      ],
    );
    const [week] = await computeGroupSpend(db, group, members, NOW);
    expect(week).toMatchObject({ spentUsd: 9, reservedUsd: 12, remainingUsd: 4 });
  });

  it("a coding child reserving the root's overrun: the tree holds the child's reservation, not the lead's budget", async () => {
    // Lead $10 with 50% overrun: its coding child reserved $10 x 1.5 = $15.
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 0, startedAt: NOW, status: "running" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 4,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 15 },
        },
      ],
    );
    const cap = { dailyBudgetUsd: null, weeklyBudgetUsd: 20, monthlyBudgetUsd: null } as never;
    const [week] = await computeGroupSpend(db, cap, [{ id: "lead", budgetUsd: 10 }, ...members.slice(1)], NOW);
    // $4 spent + $11 the child may still spend: $5 left, not the $10 that $10 - $4 would leave.
    expect(week).toMatchObject({ spentUsd: 4, reservedUsd: 11, remainingUsd: 5, heldRuns: 1 });
  });

  it("a live native sibling beside the coding child: the tree holds both unspent holds", async () => {
    // Lead $10 with 50% overrun; a native $5 child, then a coding child sized $15 - $5 = $10.
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 0, startedAt: NOW, status: "running" },
        { id: "N", agentId: "helper", costUsd: 0, startedAt: NOW, status: "running", parentRunId: "L" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 0,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 10 },
        },
      ],
      [{ id: "helper", budgetGroupId: null, budgetUsd: 5 }],
    );
    const cap = { dailyBudgetUsd: null, weeklyBudgetUsd: 20, monthlyBudgetUsd: null } as never;
    const [week] = await computeGroupSpend(db, cap, [{ id: "lead", budgetUsd: 10 }, ...members.slice(1)], NOW);
    expect(week).toMatchObject({ spentUsd: 0, reservedUsd: 15, remainingUsd: 5, heldRuns: 1 });
  });

  it("a live child reserving less than the root has left: the root's own hold wins", async () => {
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 0, startedAt: NOW, status: "running" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 2,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 10 },
        },
      ],
    );
    const [week] = await computeGroupSpend(db, group, members, NOW);
    // $21 - $2 = $19, not the child's $10 - $2 = $8.
    expect(week).toMatchObject({ spentUsd: 2, reservedUsd: 19, remainingUsd: 4, heldRuns: 1 });
  });

  it("a finished coding child no longer raises the tree's hold", async () => {
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 0, startedAt: NOW, status: "running" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 4,
          startedAt: NOW,
          status: "succeeded",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 15 },
        },
      ],
    );
    const cap = { dailyBudgetUsd: null, weeklyBudgetUsd: 20, monthlyBudgetUsd: null } as never;
    const [week] = await computeGroupSpend(db, cap, [{ id: "lead", budgetUsd: 10 }, ...members.slice(1)], NOW);
    expect(week).toMatchObject({ spentUsd: 4, reservedUsd: 6, remainingUsd: 10 });
  });

  it("two parallel children: still one hold of $21", async () => {
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 0, startedAt: NOW, status: "running" },
        {
          id: "C1",
          agentId: "builder",
          costUsd: 0,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 20 },
        },
        // Dispatch leaves the second child only what the first did not take: $21 - $20.
        {
          id: "C2",
          agentId: "builder",
          costUsd: 0,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 1 },
        },
      ],
    );
    const [week] = await computeGroupSpend(db, group, members, NOW);
    expect(week).toMatchObject({ reservedUsd: 21, remainingUsd: 4, heldRuns: 1 });
  });

  it("root finished: the child holds its own reservation", async () => {
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 1, startedAt: NOW, status: "succeeded" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 2,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 20 },
        },
      ],
    );
    const [week] = await computeGroupSpend(db, group, members, NOW);
    expect(week).toMatchObject({ spentUsd: 3, reservedUsd: 18 });
  });

  it("root in another group: the child holds its own reservation here", async () => {
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "outsider", costUsd: 0, startedAt: NOW, status: "running" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 0,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 20 },
        },
      ],
    );
    const [week] = await computeGroupSpend(db, group, members, NOW);
    expect(week).toMatchObject({ reservedUsd: 20 });
  });

  it("a grandchild under a native child is inside the root's hold; tree cost includes runs in other groups", async () => {
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 1, startedAt: NOW, status: "running" },
        { id: "N", agentId: "outsider", costUsd: 3, startedAt: NOW, status: "running", parentRunId: "L" },
        // Dispatched with $4 of the tree's $21 spent: $17 reserved.
        {
          id: "G",
          agentId: "builder",
          costUsd: 2,
          startedAt: NOW,
          status: "running",
          parentRunId: "N",
          codingRun: { budgetReservedUsd: 17 },
        },
      ],
    );
    const [week] = await computeGroupSpend(db, group, members, NOW);
    // Spent counts only members (L, G); the hold is 21 - (1 + 3 + 2).
    expect(week).toMatchObject({ spentUsd: 3, reservedUsd: 15, heldRuns: 1 });
  });

  it("a root whose hold is not counted (excluded, or after holdsBefore) leaves its children their own holds", async () => {
    // C's own reservation ($10) differs from what the root would hold ($21 - $1 = $20).
    const runs = [
      { id: "L", agentId: "lead", costUsd: 1, startedAt: TODAY_START, status: "running" },
      {
        id: "C",
        agentId: "builder",
        costUsd: 0,
        startedAt: TODAY_START,
        status: "running",
        parentRunId: "L",
        codingRun: { budgetReservedUsd: 10 },
      },
    ];
    const excluded = await computeGroupSpend(fakeDb([], runs), group, members, NOW, {
      excludeReservationRunIds: ["L"],
    });
    expect(excluded[0]).toMatchObject({ spentUsd: 1, reservedUsd: 10, heldRuns: 1 });
    // Ordered by (startedAt, id): C < K < L, so C's hold counts and L's does not.
    const before = await computeGroupSpend(fakeDb([], runs), group, members, NOW, {
      holdsBefore: { id: "K", startedAt: TODAY_START },
    });
    expect(before[0]).toMatchObject({ spentUsd: 1, reservedUsd: 10, heldRuns: 1 });
    // Neither option: the root holds the tree once.
    const [whole] = await computeGroupSpend(fakeDb([], runs), group, members, NOW);
    expect(whole).toMatchObject({ spentUsd: 1, reservedUsd: 20, heldRuns: 1 });
  });

  it("a root that started in an earlier period: the child holds its own reservation in a period the root is not in", async () => {
    const yesterday = new Date("2026-09-08T12:00:00.000Z"); // Tuesday, same ISO week as NOW
    const db = fakeDb(
      [],
      [
        { id: "L", agentId: "lead", costUsd: 1, startedAt: yesterday, status: "running" },
        {
          id: "C",
          agentId: "builder",
          costUsd: 0,
          startedAt: NOW,
          status: "running",
          parentRunId: "L",
          codingRun: { budgetReservedUsd: 20 },
        },
      ],
    );
    const [day, week] = await computeGroupSpend(
      db,
      { dailyBudgetUsd: 25, weeklyBudgetUsd: 25, monthlyBudgetUsd: null } as never,
      members,
      NOW,
    );
    expect(day).toMatchObject({ period: "day", spentUsd: 0, reservedUsd: 20, heldRuns: 1 });
    expect(week).toMatchObject({ period: "week", spentUsd: 1, reservedUsd: 20, heldRuns: 1 });
  });

  it("a dropped tree is invisible", async () => {
    const runs = [
      { id: "L", agentId: "lead", costUsd: 1, startedAt: NOW, status: "running" },
      {
        id: "C",
        agentId: "builder",
        costUsd: 2,
        startedAt: NOW,
        status: "running",
        parentRunId: "L",
        codingRun: { budgetReservedUsd: 20 },
      },
    ];
    const [week] = await computeGroupSpend(fakeDb([], runs), group, members, NOW, { excludeRunIds: ["L", "C"] });
    expect(week).toMatchObject({ spentUsd: 0, reservedUsd: 0, remainingUsd: 25, heldRuns: 0 });
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
    expect(result).toEqual({ effectiveBudgetUsd: 2, constrainedBy: ["day"], limitedBy: "day" });
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
    expect(result).toEqual({ effectiveBudgetUsd: 3, constrainedBy: ["day"], limitedBy: "day" });
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
    // The tree's ceiling: min(10, the group's $6 less what runs outside the tree spent, $0) = 6.
    // The tree has spent the root's own $1 so far, counted once: $5 left (not $6 - $1 - $1).
    const tree = await computeRunTreeSpend(db, "run-root", NOW);
    expect(tree).toEqual({ rootRunId: "run-root", capUsd: 6, spentUsd: 1, remainingUsd: 5 });
  });

  it("a running root in a binding group that delegates mid-run leaves the tree its true remainder", async () => {
    const db = fakeDb(
      [
        {
          id: "g1",
          name: "g",
          dailyBudgetUsd: 5,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agentIds: ["root-agent", "other-agent"],
        },
      ],
      [
        { id: "run-root", agentId: "root-agent", costUsd: 2, startedAt: TODAY_START, status: "running" },
        // A finished run outside the tree still counts against the group.
        { id: "run-other", agentId: "other-agent", costUsd: 0.5, startedAt: TODAY_START },
      ],
      [
        { id: "root-agent", budgetGroupId: "g1", budgetUsd: 10 },
        { id: "other-agent", budgetGroupId: "g1", budgetUsd: 1 },
      ],
    );
    // Group: $5 - $0.50 (other) - $2 (root, live) = $2.50 left; the root's own $10 is looser.
    const tree = await computeRunTreeSpend(db, "run-root", NOW);
    expect(tree).toEqual({ rootRunId: "run-root", capUsd: 4.5, spentUsd: 2, remainingUsd: 2.5 });
    // An ungrouped child gets exactly that remainder.
    const child = await effectiveBudgetForRun(
      db,
      { id: "child-agent", budgetGroupId: null, budgetUsd: 10 } as never,
      NOW,
      "run-root",
    );
    expect(child).toEqual({ effectiveBudgetUsd: 2.5, constrainedBy: ["run-tree"], limitedBy: "run-tree" });
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
    // Tree ceiling: min(6, 10 - other's $5 held, it started first) = 5; the tree has spent $1, counted once.
    const tree = await computeRunTreeSpend(db, "run-root", NOW);
    expect(tree).toEqual({ rootRunId: "run-root", capUsd: 5, spentUsd: 1, remainingUsd: 4 });
  });
});

describe("run tree: in-flight sibling holds (parallel delegations)", () => {
  const agents = [
    { id: "root-agent", budgetGroupId: null, budgetUsd: 20 },
    { id: "native-a", budgetGroupId: null, budgetUsd: 6 },
    { id: "native-b", budgetGroupId: null, budgetUsd: 15 },
    { id: "coder", budgetGroupId: null, budgetUsd: 8 },
  ];
  const root = {
    id: "run-root",
    agentId: "root-agent",
    costUsd: 2,
    startedAt: TODAY_START,
    status: "running",
    parentRunId: null,
  };

  it("an in-flight coding sibling's unspent reservation is held against the next child", async () => {
    const db = fakeDb(
      [],
      [
        root,
        {
          id: "run-c",
          agentId: "coder",
          costUsd: 1,
          startedAt: TODAY_START,
          status: "pending",
          parentRunId: "run-root",
          codingRun: { budgetReservedUsd: 8 },
        },
      ],
      agents,
    );
    // $20 − ($2 + $1) spent − ($8 − $1) held = $10.
    expect((await computeRunTreeSpend(db, "run-root", NOW)).remainingUsd).toBe(10);
  });

  it("native siblings: first come, first served by startedAt", async () => {
    const db = fakeDb(
      [],
      [
        root,
        {
          id: "run-a",
          agentId: "native-a",
          costUsd: 0,
          startedAt: TODAY_START,
          status: "running",
          parentRunId: "run-root",
        },
        { id: "run-b", agentId: "native-b", costUsd: 0, startedAt: LATER, status: "running", parentRunId: "run-root" },
      ],
      agents,
    );
    const later = await effectiveBudgetForRun(db, agents[2] as never, NOW, "run-root", {
      self: { id: "run-b", startedAt: LATER },
    });
    // $20 − $2 − a's $6 hold = $12, under b's own $15.
    expect(later.effectiveBudgetUsd).toBe(12);
    const earlier = await effectiveBudgetForRun(db, agents[1] as never, NOW, "run-root", {
      self: { id: "run-a", startedAt: TODAY_START },
    });
    // b started after a: not counted against a. a gets its own $6.
    expect(earlier.effectiveBudgetUsd).toBe(6);
  });

  it("never counts the asking run's own ancestors; every live run off the chain holds its own unspent reservation", async () => {
    const db = fakeDb(
      [],
      [
        root,
        {
          id: "run-n",
          agentId: "native-a",
          costUsd: 1,
          startedAt: TODAY_START,
          status: "running",
          parentRunId: "run-root",
        },
        {
          id: "run-s",
          agentId: "native-a",
          costUsd: 1,
          startedAt: TODAY_START,
          status: "running",
          parentRunId: "run-root",
        },
        {
          id: "run-g",
          agentId: "coder",
          costUsd: 2,
          startedAt: TODAY_START,
          status: "running",
          parentRunId: "run-s",
          codingRun: { budgetReservedUsd: 3 },
        },
      ],
      agents,
    );
    // Asking for a grandchild of run-n: run-n is an ancestor (no hold). Every live run off the chain holds its
    // own unspent reservation: run-s $6 − $1 = $5, run-g $3 − $2 = $1. Spent: 2 + 1 + 1 + 2 = 6. $20 − 6 − 6 = $8.
    expect((await computeRunTreeSpend(db, "run-n", NOW)).remainingUsd).toBe(8);
  });

  it("a coding grandchild under a native sibling holds its own reservation, beyond the sibling's budgetUsd", async () => {
    const nestedAgents = [
      { id: "root-agent", budgetGroupId: null, budgetUsd: 20 },
      { id: "native-small", budgetGroupId: null, budgetUsd: 1 },
      { id: "coder-g", budgetGroupId: null, budgetUsd: 10 },
      { id: "coder-h", budgetGroupId: null, budgetUsd: 15 },
    ];
    const live = { costUsd: 0, startedAt: TODAY_START, status: "running" };
    const db = fakeDb(
      [],
      [
        { ...live, id: "run-root", agentId: "root-agent", parentRunId: null },
        { ...live, id: "run-s", agentId: "native-small", parentRunId: "run-root" },
        { ...live, id: "run-n", agentId: "native-small", parentRunId: "run-root" },
        {
          ...live,
          id: "run-g",
          agentId: "coder-g",
          status: "pending",
          parentRunId: "run-s",
          codingRun: { budgetReservedUsd: 10 },
        },
      ],
      nestedAgents,
    );
    // n delegates coding h: s holds $1 and g, under s, its own $10. h gets $20 − 1 − 10 = $9, not its $15,
    // so s + g + h commit $20, never more than the tree's cap.
    const h = await effectiveBudgetForRun(db, nestedAgents[3] as never, NOW, "run-n");
    expect(h.effectiveBudgetUsd).toBe(9);
    expect(1 + 10 + h.effectiveBudgetUsd).toBeLessThanOrEqual(20);
  });

  it("a finished or stale sibling holds nothing", async () => {
    const db = fakeDb(
      [],
      [
        root,
        {
          id: "run-done",
          agentId: "coder",
          costUsd: 3,
          startedAt: TODAY_START,
          status: "succeeded",
          parentRunId: "run-root",
          codingRun: { budgetReservedUsd: 8 },
        },
        {
          id: "run-stale",
          agentId: "native-a",
          costUsd: 0,
          startedAt: TODAY_START,
          heartbeatAt: TODAY_START,
          status: "running",
          parentRunId: "run-root",
        },
      ],
      agents,
    );
    expect((await computeRunTreeSpend(db, "run-root", NOW)).remainingUsd).toBe(15);
  });

  it("a second child is exhausted while the first holds the tree, and admitted once it finishes under its hold", async () => {
    const tight = [{ id: "root-agent", budgetGroupId: null, budgetUsd: 10 }, ...agents.slice(1)];
    const first = {
      id: "run-first",
      agentId: "coder",
      costUsd: 0.5,
      startedAt: TODAY_START,
      status: "running",
      parentRunId: "run-root",
      codingRun: { budgetReservedUsd: 8 },
    };
    // $10 − $2 root spend − first's $8 reservation (its $0.50 counted once): nothing left for the second.
    const during = await effectiveBudgetForRun(fakeDb([], [root, first], tight), tight[3] as never, NOW, "run-root");
    expect(during.effectiveBudgetUsd).toBe(0);
    expect(during.exhaustedBy).toBe("run-tree");
    // The first finished having spent $0.50 of its $8: only that spend counts now.
    const after = await effectiveBudgetForRun(
      fakeDb([], [root, { ...first, status: "succeeded" }], tight),
      tight[3] as never,
      NOW,
      "run-root",
    );
    expect(after.effectiveBudgetUsd).toBe(7.5);
    expect(after.exhaustedBy).toBeUndefined();
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
    // The tree's ceiling is min(10, 6) = 6, minus the root's own $1 spent = 5 remaining for the tree.
    // The dispatched child's own budgetUsd (100) is far looser, so the tree ceiling wins.
    const result = await effectiveBudgetForRun(
      db,
      { id: "child-agent", budgetGroupId: null, budgetUsd: 100 } as never,
      NOW,
      "run-root",
    );
    expect(result).toEqual({ effectiveBudgetUsd: 5, constrainedBy: ["run-tree"], limitedBy: "run-tree" });
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
    expect(result).toEqual({
      effectiveBudgetUsd: 0,
      constrainedBy: ["run-tree"],
      limitedBy: "run-tree",
      exhaustedBy: "run-tree",
      exhaustedDetail: { capUsd: 2, spentUsd: 2, heldUsd: 0, heldRuns: 0 },
    });
  });

  it("a top-level run (no parentRunId) is unaffected by run-tree logic entirely", async () => {
    const db = fakeDb([], []);
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: null, budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 5, constrainedBy: [] });
  });
});

describe("an allowed overrun is never reserved", () => {
  const tree = (rootOverrunPercent: number) =>
    fakeDb(
      [],
      [{ id: "run-root", agentId: "root-agent", costUsd: 2.1, startedAt: TODAY_START, status: "running" }],
      [
        { id: "root-agent", budgetGroupId: null, budgetUsd: 2, allowedOverrunPercent: rootOverrunPercent },
        { id: "child-agent", budgetGroupId: null, budgetUsd: 1, allowedOverrunPercent: 50 },
      ],
    );
  const child = { id: "child-agent", budgetGroupId: null, budgetUsd: 1, allowedOverrunPercent: 50 } as never;

  it("a delegated child's base comes from the root's budget, not its overrun-raised ceiling: the tree is spent", async () => {
    const result = await effectiveBudgetForRun(tree(25), child, NOW, "run-root");
    expect(result.effectiveBudgetUsd).toBe(0);
    expect(result.exhaustedBy).toBe("run-tree");
    expect(result.exhaustedDetail).toMatchObject({ capUsd: 2, spentUsd: 2.1 });
  });

  it("a p=50 agent gets its own budget, top-level and delegated", async () => {
    const top = await effectiveBudgetForRun(
      fakeDb(
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
        [],
      ),
      { id: "a1", budgetGroupId: "g1", budgetUsd: 5, allowedOverrunPercent: 50 } as never,
      NOW,
    );
    expect(top).toEqual({ effectiveBudgetUsd: 5, constrainedBy: [] });

    const db = fakeDb(
      [],
      [{ id: "run-root", agentId: "root-agent", costUsd: 1, startedAt: TODAY_START, status: "running" }],
      [{ id: "root-agent", budgetGroupId: null, budgetUsd: 2, allowedOverrunPercent: 50 }],
    );
    const delegated = await effectiveBudgetForRun(
      db,
      { id: "child-agent", budgetGroupId: null, budgetUsd: 5, allowedOverrunPercent: 50 } as never,
      NOW,
      "run-root",
    );
    expect(delegated).toEqual({ effectiveBudgetUsd: 1, constrainedBy: ["run-tree"], limitedBy: "run-tree" });
  });

  it("a coding run's hold in its group is its grant: its base plus the top-ups granted so far", async () => {
    const db = fakeDb(
      [],
      [
        {
          id: "c1",
          agentId: "coder",
          costUsd: 0,
          startedAt: TODAY_START,
          status: "running",
          codingRun: { budgetReservedUsd: 1.1 },
        },
      ],
    );
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: 5, weeklyBudgetUsd: null, monthlyBudgetUsd: null } as never,
      [{ id: "coder", budgetUsd: 1 }],
      NOW,
    );
    expect(spend[0]).toMatchObject({ reservedUsd: 1.1, remainingUsd: 3.9, heldRuns: 1 });
  });
});
