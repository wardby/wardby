/**
 * Release invariant 2: budgets, model-based. Random worlds (a budget group with daily and monthly
 * caps; native and coding agents with their own budgets and allowed overruns; delegation trees;
 * runs started, spending, delegating and finishing in random interleavings) are driven step by
 * step through the real budget code (effectiveBudgetForRun, as the runner and dispatch call it)
 * over the in-memory database the unit tests use. After every step:
 *
 * - group: the spend every run of the group can still reach (a live run's pinned limit, else its
 *   cost) stays within each of the group's caps;
 * - tree: the spend a delegated run tree can still reach stays within its root's ceiling (the
 *   root agent's budgetUsd, raised by its allowedOverrunPercent for coding sub-agents).
 *
 * How a run spends is modelled on the engine: a native run spends its own model calls up to the
 * limit pinned at load (runner.ts: effectiveBudgetForRun, then engine-native's budget gate on its
 * own cumulative cost); a coding run spends up to its reservation (the proxy's session budget).
 * A lead spends only while none of its children runs (sequential delegation).
 */
import { afterEach, describe, expect, it } from "vitest";
import { MIN_RESERVATION_USD, effectiveBudgetForRun } from "../core/budget-groups.js";
import { fakeBudgetDb, type FakeAgent, type FakeGroup, type FakeRun } from "../core/budget-groups.test-support.js";
import { forAll, type Rng } from "./seeded.test-support.js";
import { secretSweep, type SecretSweep } from "./secret-sweep.test-support.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const TODAY = new Date("2026-10-19T00:00:00.000Z");
const EPSILON = 1e-6;

let sweep: SecretSweep | undefined;
afterEach(() => {
  sweep?.dispose();
  sweep = undefined;
});

interface ModelAgent extends FakeAgent {
  kind: "native" | "coding";
  allowedOverrunPercent: number;
}

interface ModelRun extends FakeRun {
  id: string;
  kind: "native" | "coding";
  status: "running" | "succeeded" | "refused";
  /** What the run can spend in total: a native run's pinned budget, a coding run's reservation. */
  limit: number;
}

interface World {
  group: FakeGroup;
  agents: ModelAgent[];
  runs: ModelRun[];
  clock: number;
}

const floorMicro = (usd: number) => Math.floor(usd / MIN_RESERVATION_USD) * MIN_RESERVATION_USD;
const money = (r: Rng, min: number, max: number) => Math.round((min + r.next() * (max - min)) * 100) / 100;

function newWorld(r: Rng, options: Options): World {
  const agents: ModelAgent[] = [
    ...Array.from({ length: r.int(1, 3) }, (_, i): ModelAgent => ({
      id: `native-${i}`,
      kind: "native",
      budgetGroupId: "g",
      budgetUsd: money(r, 1, 20),
      allowedOverrunPercent: options.leadOverrun ? r.pick([0, 0, 10, 50]) : 0,
    })),
    ...Array.from({ length: r.int(1, 3) }, (_, i): ModelAgent => ({
      id: `coding-${i}`,
      kind: "coding",
      budgetGroupId: "g",
      budgetUsd: money(r, 1, 20),
      allowedOverrunPercent: r.pick([0, 10, 25, 50, 100]),
    })),
  ];
  const daily = money(r, 5, 40);
  return {
    group: {
      id: "g",
      name: "release-group",
      dailyBudgetUsd: daily,
      weeklyBudgetUsd: null,
      monthlyBudgetUsd: r.bool() ? money(r, daily, daily * 3) : null,
      warnThresholdRatio: 2,
      agentIds: agents.map((a) => a.id),
    },
    agents,
    runs: [],
    clock: 0,
  };
}

const dbOf = (w: World) => fakeBudgetDb([w.group], w.runs, w.agents, NOW);
const live = (run: ModelRun) => run.status === "running";
const childrenOf = (w: World, id: string) => w.runs.filter((run) => run.parentRunId === id);
const rootOf = (w: World, run: ModelRun): ModelRun => {
  let current = run;
  while (current.parentRunId) current = w.runs.find((r) => r.id === current.parentRunId)!;
  return current;
};
const agentOf = (w: World, run: ModelRun) => w.agents.find((a) => a.id === run.agentId)!;

/** What a run can still bring the spend to: a live run its limit, a finished one its cost. */
const reach = (run: ModelRun) => (live(run) ? Math.max(run.costUsd, run.limit) : run.costUsd);

/** The model's agent as the Agent row the budget code reads (budgetUsd is a Decimal there; Number() reads both). */
const asAgentRow = (agent: ModelAgent) => agent as unknown as Parameters<typeof effectiveBudgetForRun>[1];

async function start(w: World, agent: ModelAgent, parent?: ModelRun): Promise<void> {
  const id = `run-${w.runs.length}`;
  const startedAt = new Date(TODAY.getTime() + 1000 * ++w.clock);
  const base = { id, agentId: agent.id, kind: agent.kind, costUsd: 0, startedAt, parentRunId: parent?.id ?? null };
  if (agent.kind === "native") {
    // The runner: the row exists first, then the run asks for its budget at load (self).
    const run: ModelRun = { ...base, status: "running", limit: 0 };
    w.runs.push(run);
    const { effectiveBudgetUsd } = await effectiveBudgetForRun(dbOf(w), asAgentRow(agent), NOW, parent?.id, {
      self: { id, startedAt },
    });
    run.limit = effectiveBudgetUsd;
    // The engine's turn-1 gate refuses a budget it cannot spend.
    if (effectiveBudgetUsd < MIN_RESERVATION_USD) run.status = "refused";
    return;
  }
  // Dispatch (reserveCodingBudget, since overrun-from-room #424): no row yet; the reservation is the
  // base, min(budget, effective). The overrun is not reserved up front: it comes later, only from
  // top-ups the group and tree have room for (budget-topup.ts), which this model does not take.
  const effective = await effectiveBudgetForRun(dbOf(w), asAgentRow(agent), NOW, parent?.id);
  const reservation = floorMicro(Math.min(agent.budgetUsd, effective.effectiveBudgetUsd));
  if (reservation < MIN_RESERVATION_USD) {
    w.runs.push({ ...base, status: "refused", limit: 0 });
    return;
  }
  w.runs.push({ ...base, status: "running", limit: reservation, codingRun: { budgetReservedUsd: reservation } });
}

interface Options {
  delegation: boolean;
  /**
   * How a lead's own model spend is bounded: "pinned" (what the engine does: its limit pinned at
   * load, its own calls only) or "tree" (what the docs promise: the tree's ceiling minus what the
   * whole tree has spent).
   */
  leadSpend: "pinned" | "tree";
  /** Whether native (lead) agents get an allowedOverrunPercent, which raises their tree's ceiling for coding sub-agents. */
  leadOverrun: boolean;
}

function spendRoom(w: World, run: ModelRun, options: Options): number {
  const own = run.limit - run.costUsd;
  const isLead = run.kind === "native" && childrenOf(w, run.id).length > 0;
  if (!isLead || options.leadSpend === "pinned") return own;
  const root = rootOf(w, run);
  const treeCost = w.runs.filter((other) => rootOf(w, other).id === root.id).reduce((sum, o) => sum + o.costUsd, 0);
  return Math.min(own, root.limit - treeCost);
}

const isLead = (w: World, run: ModelRun) => run.kind === "native" && childrenOf(w, run.id).length > 0;

async function step(w: World, r: Rng, options: Options): Promise<string> {
  const running = w.runs.filter(live);
  // A lead waits on a running child: only runs with no running child act.
  const idle = running.filter((run) => !childrenOf(w, run.id).some(live));
  const choice = r.int(0, 9);
  if (choice <= 2 || running.length === 0) {
    const agent = r.pick(w.agents);
    await start(w, agent);
    return `start ${agent.id}`;
  }
  if (options.delegation && choice <= 4) {
    const leads = idle.filter((run) => run.kind === "native" && depth(w, run) < 2);
    if (leads.length > 0) {
      const lead = r.pick(leads);
      const child = r.pick(w.agents);
      await start(w, child, lead);
      return `${lead.id} delegates to ${child.id}`;
    }
  }
  if (choice <= 7 && idle.length > 0) {
    const run = r.pick(idle);
    const room = Math.max(0, spendRoom(w, run, options));
    run.costUsd += r.bool(0.3) ? room : Math.round(room * r.next() * 1e6) / 1e6;
    return `${run.id} spends to ${run.costUsd.toFixed(6)}`;
  }
  if (idle.length > 0) {
    const run = r.pick(idle);
    run.status = "succeeded";
    return `${run.id} finishes`;
  }
  return "idle";
}

function depth(w: World, run: ModelRun): number {
  let d = 0;
  for (let current = run; current.parentRunId; d++) current = w.runs.find((x) => x.id === current.parentRunId)!;
  return d;
}

/**
 * What a run tree (a root and everything below it) can still bring its spend to. Pinned: every
 * live run up to its own limit. Tree-bounded: every live run that is not a lead up to its limit
 * (`base`); the leads' own calls then add at most their unspent limits, and never take the tree
 * past the root's limit.
 */
function treeReach(w: World, root: ModelRun, options: Options): number {
  const tree = w.runs.filter((run) => rootOf(w, run).id === root.id);
  if (options.leadSpend === "pinned") return tree.reduce((sum, run) => sum + reach(run), 0);
  const leads = tree.filter((run) => live(run) && isLead(w, run));
  const base = tree.reduce((sum, run) => sum + (leads.includes(run) ? run.costUsd : reach(run)), 0);
  const leadRoom = leads.reduce((sum, run) => sum + Math.max(0, run.limit - run.costUsd), 0);
  return leadRoom > 0 ? Math.max(base, Math.min(base + leadRoom, root.limit)) : base;
}

function describeWorld(w: World, trace: string[]): string {
  const runs = w.runs.map(
    (run) =>
      `${run.id} ${run.agentId}${run.parentRunId ? ` <- ${run.parentRunId}` : ""} ${run.status} ` +
      `cost=${run.costUsd.toFixed(6)} limit=${run.limit.toFixed(6)}`,
  );
  return `\n  steps:\n    ${trace.join("\n    ")}\n  runs:\n    ${runs.join("\n    ")}`;
}

function checkInvariants(w: World, trace: string[], options: Options) {
  const caps = [w.group.dailyBudgetUsd, w.group.monthlyBudgetUsd].filter((c): c is number => c !== null);
  const roots = w.runs.filter((run) => !run.parentRunId);
  const groupReach = roots.reduce((sum, root) => sum + treeReach(w, root, options), 0);
  for (const cap of caps) {
    if (groupReach > cap + EPSILON) {
      throw new Error(`group reach ${groupReach.toFixed(6)} > cap ${cap}${describeWorld(w, trace)}`);
    }
  }
  for (const root of roots.filter((run) => childrenOf(w, run.id).length > 0)) {
    const rootAgent = agentOf(w, root);
    const ceiling = (rootAgent.budgetUsd * (100 + rootAgent.allowedOverrunPercent)) / 100;
    const reached = treeReach(w, root, options);
    if (reached > ceiling + EPSILON) {
      throw new Error(`tree ${root.id} reach ${reached.toFixed(6)} > ceiling ${ceiling}${describeWorld(w, trace)}`);
    }
  }
}

async function simulate(salt: string, worlds: number, steps: number, options: Options): Promise<number> {
  let checked = 0;
  sweep = secretSweep(worlds);
  await forAll(salt, worlds, async (r) => {
    const w = newWorld(r, options);
    const trace: string[] = [
      `caps day=${w.group.dailyBudgetUsd} month=${w.group.monthlyBudgetUsd}; agents ${w.agents
        .map((a) => `${a.id}:$${a.budgetUsd}+${a.allowedOverrunPercent}%`)
        .join(" ")}`,
    ];
    for (let i = 0; i < steps; i++) {
      trace.push(await step(w, r, options));
      checkInvariants(w, trace, options);
      checked += 1;
    }
  });
  // Budget code logs (group warnings) are part of the output this file touches.
  sweep.assertClean();
  return checked;
}

/** A world with one group (daily cap only) and the given agents, all in it. */
function fixedWorld(dailyCapUsd: number, agents: ModelAgent[]): World {
  return {
    group: {
      id: "g",
      name: "g",
      dailyBudgetUsd: dailyCapUsd,
      weeklyBudgetUsd: null,
      monthlyBudgetUsd: null,
      warnThresholdRatio: 2,
      agentIds: agents.map((a) => a.id),
    },
    agents,
    runs: [],
    clock: 0,
  };
}
const agent = (id: string, kind: ModelAgent["kind"], budgetUsd: number, allowedOverrunPercent = 0): ModelAgent => ({
  id,
  kind,
  budgetGroupId: "g",
  budgetUsd,
  allowedOverrunPercent,
});

const WORLDS = 150;
const STEPS = 30;

describe("budget invariants (model-based)", () => {
  it("flat worlds: concurrent native and coding runs never reach past any group cap", async () => {
    const options: Options = { delegation: false, leadSpend: "pinned", leadOverrun: true };
    expect(await simulate("budget.flat", WORLDS, STEPS, options)).toBe(WORLDS * STEPS);
  });

  it("delegation trees, leads without an overrun and bounded by their tree: no group cap or tree ceiling is passed", async () => {
    const options: Options = { delegation: true, leadSpend: "tree", leadOverrun: false };
    expect(await simulate("budget.tree", WORLDS, STEPS, options)).toBe(WORLDS * STEPS);
  });

  it("bug 3: a coding child reserving the lead's overrun leaves the group no room past its cap", async () => {
    const w = fixedWorld(20, [
      agent("lead", "native", 10, 50),
      agent("builder", "coding", 10, 50),
      agent("other", "coding", 10),
    ]);
    await start(w, w.agents[0]);
    await start(w, w.agents[1], w.runs[0]);
    // Since overrun-from-room (#424) dispatch reserves the base only; the overrun comes later
    // from top-ups the group has room for (not modelled here).
    expect(w.runs[1].limit).toBe(10);
    await start(w, w.agents[2]);
    // The group holds the builder's $10 for the tree, so the other run gets at most $10.
    expect(w.runs[2].limit).toBeLessThanOrEqual(10 + EPSILON);
    checkInvariants(w, ["lead starts", "lead delegates to builder", "other starts"], {
      delegation: true,
      leadSpend: "tree",
      leadOverrun: true,
    });
  });

  // Was FINDING B2 (a coding child reserved the lead's overrun up front, past the group cap). Resolved by
  // overrun-from-room (#424): dispatch reserves the base only, and the overrun comes from top-ups the
  // group and tree have room for. Confirmed on production dispatchRun (confirmations.release.test.ts).
  // The model does not take top-ups yet, so it checks the dispatch side only.
  it("delegation trees, leads with an overrun and bounded by their tree: no group cap or tree ceiling is passed", async () => {
    await simulate("budget.tree-overrun", WORLDS, STEPS, { delegation: true, leadSpend: "tree", leadOverrun: true });
  });

  // Was FINDING B2; resolved by #424 (see above): the builder reserves its base, so the group stays at its cap.
  it("B2, smallest case: a run started between a lead and its overrun-raised builder takes the group past its cap", async () => {
    const w = fixedWorld(20, [
      agent("lead", "native", 10, 50),
      agent("builder", "coding", 10, 50),
      agent("other", "coding", 10),
    ]);
    await start(w, w.agents[0]);
    await start(w, w.agents[2]);
    // The group held the lead's $10, so the other run got the remaining $10.
    expect(w.runs[1].limit).toBe(10);
    await start(w, w.agents[1], w.runs[0]);
    checkInvariants(w, ["lead starts", "other starts", "lead delegates to builder"], {
      delegation: true,
      leadSpend: "tree",
      leadOverrun: true,
    });
  });

  // FINDING: B1, unconfirmed; see regression-phase1-report.md. a lead's own model spend is bounded only by the budget
  // pinned when it loaded (runner.ts effectiveBudgetForRun, then engine-native's gate on its own
  // cumulative cost), never by what its tree has spent since. Its children are given the tree's
  // remainder (computeRunTreeSpend leaves the lead's own unspent budget out, as an ancestor), and
  // the group holds max(lead budget - tree cost, coding holds) for the tree, not their sum. So after
  // a child spends, the lead can still spend its whole budget: the tree reaches past the lead's
  // budget, and the group past its cap.
  // Known finding, expected to fail until fixed in the order of docs/private/2026-10-26-regression-findings-fix-order.md;
  // the fixing PR turns this into a normal `it`.
  it.fails(
    "delegation trees, each lead spending up to its pinned budget (the engine today): no group cap or tree ceiling is passed",
    async () => {
      await simulate("budget.pinned", WORLDS, STEPS, { delegation: true, leadSpend: "pinned", leadOverrun: false });
    },
  );

  // Known finding, expected to fail until fixed in the order of docs/private/2026-10-26-regression-findings-fix-order.md;
  // the fixing PR turns this into a normal `it`.
  it.fails("B1, smallest case: a $10 lead that delegates a $10 builder can bring its tree to $20", async () => {
    const w = fixedWorld(100, [agent("lead", "native", 10), agent("builder", "coding", 10)]);
    await start(w, w.agents[0]);
    await start(w, w.agents[1], w.runs[0]);
    // The builder is given the whole tree ($10) while the lead's own $10 is still unspent.
    expect(w.runs[1].limit).toBe(10);
    checkInvariants(w, ["lead starts", "lead delegates to builder"], {
      delegation: true,
      leadSpend: "pinned",
      leadOverrun: false,
    });
  });
});
