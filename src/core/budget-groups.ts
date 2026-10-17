/**
 * Daily/weekly/monthly spend caps for a *group* of agents (BudgetGroup),
 * layered on top of each agent's own per-run Agent.budgetUsd. Unlike
 * budget.ts (pure, no DB, no network), this module queries Postgres: it
 * computes how much of a group's remaining period budget a given agent
 * should be allowed to spend on its next run, and hands back an
 * *effective* per-run budget the caller uses in place of the agent's raw
 * budgetUsd. The engine's existing turn-by-turn machinery (pre-flight
 * refuse, mid-stream cutoff, wind-down — see engine-native.ts) then
 * enforces that tightened ceiling with no changes of its own: a group
 * whose period budget is already exhausted simply produces an effective
 * budget of 0, which the engine's turn-1 gate already refuses exactly
 * like any other zero/negative budget. A coding run gets the same effective
 * budget at dispatch (dispatch.ts), where it becomes the run's reservation.
 *
 * Spend is the real cost of the period's runs plus the unspent part of every
 * live run still in flight (pending or running): its hold, minus what it has
 * spent so far, never below zero. A coding run's hold is its
 * CodingRun.budgetReservedUsd; a native run's is its agent's current
 * per-run budgetUsd, an upper bound on the effective budget it pinned at load.
 * Counting holds is what stops concurrent runs from each claiming the
 * same remainder (security review E-04).
 *
 * Only live runs hold anything (see isHoldLive): a run that stopped
 * heartbeating (a crashed process, a Ctrl-C'd `wardby run`) or a coding run
 * past its queue + run timeout releases its hold even while its row still
 * says pending/running, so a zombie row cannot pin a group for a whole period.
 *
 * A native run asks for its budget at load, after its row already exists, and
 * counts only the holds of runs that started before it (startedAt, then id):
 * first come, first served. Two members dispatched on the same tick never
 * both see the other's hold and starve each other; the earlier one gets the
 * remainder and the later one gets what the earlier one leaves. A coding
 * dispatch has no row yet, so it counts every live hold.
 */
import type { Agent, BudgetGroup, PrismaClient } from "#prisma";
import { loadCodingConcurrencyConfig } from "../config/providers.js";
import { logger } from "./logger.js";
import { HEARTBEAT_TIMEOUT_MS, RECONCILE_INTERVAL_MS } from "./timing.js";

const budgetGroupLog = logger.child({ module: "budget-groups" });

export type Period = "day" | "week" | "month";

export type BudgetGroupsDb = Pick<PrismaClient, "budgetGroup" | "run" | "agent">;

/**
 * Calendar-aligned UTC period start. "week" is the ISO week: Monday 00:00
 * UTC. `now`'s own time-of-day/day-of-week is truncated away, never
 * rounded up -- a period start is always <= now.
 */
export function periodStart(period: Period, now: Date): Date {
  if (period === "day") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (period === "month") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  // getUTCDay(): Sunday=0 .. Saturday=6. Treat Sunday as 7 so "days since
  // Monday" is always 0-6.
  const daysSinceMonday = (now.getUTCDay() || 7) - 1;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export interface PeriodSpend {
  period: Period;
  capUsd: number;
  /** Real cost recorded by the period's runs, finished or not. */
  spentUsd: number;
  /** Unspent reservations of the period's in-flight (pending/running) runs. */
  reservedUsd: number;
  /** capUsd - spentUsd - reservedUsd, never below zero. */
  remainingUsd: number;
  /** How many of the period's runs hold something (reservedUsd > 0 each). */
  heldRuns: number;
}

/** A group member as computeGroupSpend needs it: a native run in flight holds its agent's budgetUsd. */
export interface GroupMember {
  id: string;
  budgetUsd: unknown;
}

/** A run's position in first-come-first-served order: startedAt, then id. */
export interface RunOrder {
  id: string;
  startedAt: Date;
}

export interface SpendOptions {
  /**
   * Runs whose unspent hold is left out (their real cost still counts): the
   * run asking for its own budget, and the run tree a sub-agent spends from,
   * whose hold already covers it.
   */
  excludeReservationRunIds?: readonly string[];
  /**
   * Runs left out of the group's spend entirely, real cost and hold alike:
   * the run tree when computing the tree's own ceiling, whose spend is
   * subtracted from that ceiling separately and must count only once.
   */
  excludeRunIds?: readonly string[];
  /**
   * First come, first served: count only the holds of runs ordered strictly
   * before this one. Unset (a coding dispatch, whose row does not exist yet)
   * counts every live hold.
   */
  holdsBefore?: RunOrder;
  /** CODING_QUEUE_TIMEOUT_SEC; read from the environment when omitted. */
  codingQueueTimeoutSec?: number;
}

const IN_FLIGHT = new Set(["pending", "running"]);

/**
 * How long a run's last heartbeat keeps its hold alive: the reconciler's
 * heartbeat timeout plus one reconcile interval, so a managed run is reaped
 * (or re-claimed, which refreshes heartbeatAt) before its hold lapses.
 * Managed native runs beat every HEARTBEAT_INTERVAL_MS (InProcessExecutor,
 * DbosExecutor), as do `wardby run` and native sub-agent children
 * (withRunHeartbeat); a coding run beats while its job is polled.
 */
export const HOLD_HEARTBEAT_TTL_MS = HEARTBEAT_TIMEOUT_MS + RECONCILE_INTERVAL_MS;
/** Slack past a coding run's queue + run timeout before its hold lapses (matches the sub-agent wait grace). */
export const CODING_HOLD_GRACE_SEC = 60;
/** Smallest amount worth holding or reserving: CodingRun.budgetReservedUsd has 6 decimal places. */
export const MIN_RESERVATION_USD = 0.000001;

interface HoldRow {
  id: string;
  status: string;
  startedAt: Date;
  heartbeatAt: Date | null;
  codingRun: { timeoutSec: number } | null;
}

/**
 * Whether an in-flight row still holds budget. A run holds while its last
 * sign of life (heartbeatAt, or startedAt before its first beat) is within
 * HOLD_HEARTBEAT_TTL_MS. A coding run also holds, beat or not, until its
 * queue timeout + run timeout + grace have passed since dispatch: a queued
 * coding run does not beat, and nothing can legitimately spend past that.
 */
export function isHoldLive(run: HoldRow, now: Date, codingQueueTimeoutSec: number): boolean {
  if (!IN_FLIGHT.has(run.status)) return false;
  const lastSign = (run.heartbeatAt ?? run.startedAt).getTime();
  if (now.getTime() - lastSign <= HOLD_HEARTBEAT_TTL_MS) return true;
  if (run.codingRun) {
    const deadlineMs =
      run.startedAt.getTime() + (codingQueueTimeoutSec + run.codingRun.timeoutSec + CODING_HOLD_GRACE_SEC) * 1000;
    return now.getTime() <= deadlineMs;
  }
  return false;
}

function isOrderedBefore(run: RunOrder, other: RunOrder): boolean {
  const a = run.startedAt.getTime();
  const b = other.startedAt.getTime();
  return a < b || (a === b && run.id < other.id);
}

/**
 * Live per-period spend for whichever of a group's daily/weekly/monthly
 * caps are actually set -- unset periods are omitted from the result, not
 * returned with a null cap. One query at the widest configured window
 * (month contains week contains day), bucketed in JS, rather than a
 * separate DB round trip per period.
 *
 * A delegated run tree is held once, at its root. A sub-run whose tree root
 * is a counted run of this group with a live, counted hold spends inside the
 * root's hold, so it holds nothing (its cost still counts as spent), and the
 * root holds its reservation minus the cost of every run in its tree. A sub-run
 * whose root is in another group, has finished, or whose hold is left out
 * here (excludeReservationRunIds, holdsBefore) holds its own reservation. So
 * does a sub-run in a period its root did not start in (a root that started
 * yesterday, a child today: today's daily cap still holds the child's own
 * reservation, since the root's hold falls in yesterday's bucket).
 */
export async function computeGroupSpend(
  db: BudgetGroupsDb,
  group: Pick<BudgetGroup, "dailyBudgetUsd" | "weeklyBudgetUsd" | "monthlyBudgetUsd">,
  members: readonly GroupMember[],
  now: Date = new Date(),
  options: SpendOptions = {},
): Promise<PeriodSpend[]> {
  const caps: { period: Period; capUsd: number | null }[] = [
    { period: "day", capUsd: toNullableNumber(group.dailyBudgetUsd) },
    { period: "week", capUsd: toNullableNumber(group.weeklyBudgetUsd) },
    { period: "month", capUsd: toNullableNumber(group.monthlyBudgetUsd) },
  ];
  const configured = caps.filter((c): c is { period: Period; capUsd: number } => c.capUsd !== null);
  if (configured.length === 0) return [];

  // A cap can be configured before any agent is ever attached to the group
  // (e.g. right after create_budget_group) -- that's still a real,
  // reportable state (spentUsd: 0), not "nothing to report." Only skip the
  // query itself as a cheap no-op; an empty `agentId: { in: [] }` would
  // match nothing anyway.
  const widestStart = periodStart("month", now);
  const memberBudgets = new Map(members.map((m) => [m.id, Number(m.budgetUsd)]));
  const excluded = new Set(options.excludeReservationRunIds ?? []);
  const dropped = new Set(options.excludeRunIds ?? []);
  const queueTimeoutSec = options.codingQueueTimeoutSec ?? loadCodingConcurrencyConfig().queueTimeoutSec;
  const runs =
    members.length === 0
      ? []
      : await db.run.findMany({
          where: { agentId: { in: [...memberBudgets.keys()] }, startedAt: { gte: widestStart } },
          select: {
            id: true,
            agentId: true,
            status: true,
            costUsd: true,
            startedAt: true,
            heartbeatAt: true,
            parentRunId: true,
            codingRun: { select: { budgetReservedUsd: true, timeoutSec: true } },
          },
        });

  const counted = runs.filter((r) => !dropped.has(r.id));
  const countedById = new Map(counted.map((r) => [r.id, r]));
  const holds = (r: (typeof counted)[number]): boolean =>
    !excluded.has(r.id) &&
    (options.holdsBefore === undefined || isOrderedBefore(r, options.holdsBefore)) &&
    isHoldLive(r, now, queueTimeoutSec);
  // A coding run holds exactly what dispatch reserved. A native run (or a
  // coding run whose CodingRun row is missing) holds its agent's per-run
  // budget: never less than what it can actually spend.
  const reservationOf = (r: (typeof counted)[number]): number =>
    r.codingRun != null ? Number(r.codingRun.budgetReservedUsd) : (memberBudgets.get(r.agentId) ?? 0);

  // A run inside the tree of a counted, holding root in this group spends
  // inside that root's hold, so it holds nothing of its own.
  const rootOf = await resolveRootRunIds(db, counted);
  const heldRoots = new Set<string>();
  for (const r of counted) {
    const rootId = rootOf.get(r.id);
    if (rootId === undefined || rootId === r.id) continue;
    const root = countedById.get(rootId);
    if (root && holds(root)) heldRoots.add(rootId);
  }
  // Such a root holds its reservation minus the cost of its whole tree, every
  // run in it included (also runs in other groups: they spend the tree too).
  const treeCostByRoot = new Map<string, number>();
  for (const rootId of heldRoots) {
    const treeRunIds = await collectTreeRunIds(db, rootId);
    const treeRuns = await db.run.findMany({ where: { id: { in: treeRunIds } }, select: { costUsd: true } });
    treeCostByRoot.set(
      rootId,
      treeRuns.reduce((sum, t) => sum + Number(t.costUsd), 0),
    );
  }

  const accounted = counted.map((r) => {
    const costUsd = Number(r.costUsd);
    const rootId = rootOf.get(r.id);
    let ownReservedUsd = 0;
    if (heldRoots.has(r.id)) {
      ownReservedUsd = Math.max(0, reservationOf(r) - (treeCostByRoot.get(r.id) ?? 0));
    } else if (holds(r)) {
      ownReservedUsd = Math.max(0, reservationOf(r) - costUsd);
    }
    // Set when the run spends inside its root's hold: the root's startedAt.
    const heldRootStartedAt =
      rootId !== undefined && rootId !== r.id && heldRoots.has(rootId) ? countedById.get(rootId)!.startedAt : null;
    return { startedAt: r.startedAt, costUsd, ownReservedUsd, heldRootStartedAt };
  });

  return configured.map(({ period, capUsd }) => {
    const start = periodStart(period, now);
    // A run inside a held tree holds nothing in a period only when its root's
    // hold is counted in that period too (the root started in it); otherwise
    // the period would see the run's spend but no hold for it.
    const inPeriod = accounted
      .filter((r) => r.startedAt >= start)
      .map((r) => ({
        costUsd: r.costUsd,
        reservedUsd: r.heldRootStartedAt !== null && r.heldRootStartedAt >= start ? 0 : r.ownReservedUsd,
      }));
    const spentUsd = inPeriod.reduce((sum, r) => sum + r.costUsd, 0);
    const reservedUsd = inPeriod.reduce((sum, r) => sum + r.reservedUsd, 0);
    const heldRuns = inPeriod.filter((r) => r.reservedUsd > 0).length;
    return {
      period,
      capUsd,
      spentUsd,
      reservedUsd,
      remainingUsd: Math.max(0, capUsd - spentUsd - reservedUsd),
      heldRuns,
    };
  });
}

/** Deepest parentRunId chain resolveRootRunIds follows: a guard against a cycle. */
const MAX_TREE_DEPTH = 32;

/**
 * Each run's tree root (the ancestor with parentRunId null), walking
 * parentRunId upward in one batched query per level. A run whose chain cannot
 * be resolved (a missing ancestor, or deeper than MAX_TREE_DEPTH) is left out.
 */
async function resolveRootRunIds(
  db: Pick<BudgetGroupsDb, "run">,
  runs: readonly { id: string; parentRunId: string | null }[],
): Promise<Map<string, string>> {
  const parentOf = new Map<string, string | null>(runs.map((r) => [r.id, r.parentRunId ?? null]));
  const missing = new Set<string>();
  for (let level = 0; level < MAX_TREE_DEPTH; level++) {
    const unresolved = new Set<string>();
    for (const parentId of parentOf.values()) {
      if (parentId !== null && !parentOf.has(parentId) && !missing.has(parentId)) unresolved.add(parentId);
    }
    if (unresolved.size === 0) break;
    const parents = await db.run.findMany({
      where: { id: { in: [...unresolved] } },
      select: { id: true, parentRunId: true, agentId: true },
    });
    for (const p of parents) parentOf.set(p.id, p.parentRunId ?? null);
    for (const id of unresolved) if (!parentOf.has(id)) missing.add(id);
  }

  const rootOf = new Map<string, string>();
  for (const r of runs) {
    let id = r.id;
    let parentId = parentOf.get(id);
    for (let depth = 0; parentId != null && depth < MAX_TREE_DEPTH; depth++) {
      id = parentId;
      parentId = parentOf.get(id);
    }
    // parentId undefined: a missing ancestor; non-null: too deep or a cycle.
    if (parentId === null) rootOf.set(r.id, id);
  }
  return rootOf;
}

export interface RunTreeSpend {
  rootRunId: string;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
}

/** Walks parentRunId upward from `runId` to the tree's root (parentRunId null). */
async function findRootRun(
  db: Pick<BudgetGroupsDb, "run">,
  runId: string,
): Promise<{ id: string; agentId: string; parentRunId: string | null; startedAt: Date }> {
  let current = await db.run.findUniqueOrThrow({
    where: { id: runId },
    select: { id: true, agentId: true, parentRunId: true, startedAt: true },
  });
  while (current.parentRunId) {
    current = await db.run.findUniqueOrThrow({
      where: { id: current.parentRunId },
      select: { id: true, agentId: true, parentRunId: true, startedAt: true },
    });
  }
  return current;
}

/** Breadth-first walk down childRuns from `rootRunId`, collecting every run id in the tree. */
async function collectTreeRunIds(db: Pick<BudgetGroupsDb, "run">, rootRunId: string): Promise<string[]> {
  const all = [rootRunId];
  let frontier = [rootRunId];
  while (frontier.length > 0) {
    const children = await db.run.findMany({ where: { parentRunId: { in: frontier } }, select: { id: true } });
    const childIds = children.map((c) => c.id);
    all.push(...childIds);
    frontier = childIds;
  }
  return all;
}

/**
 * Real-time shared budget scope for a sub-agent dispatch: the whole run tree
 * rooted at `parentRunId`'s ultimate ancestor shares one ceiling —
 * the root's own budgetUsd, itself tightened by the root agent's BudgetGroup
 * if any — minus everything every run in the tree has spent so far. The
 * ceiling is recomputed fresh here, not pinned from whatever it was when the
 * root run started — consistent with BudgetGroup periods already always
 * being live-recomputed rather than snapshotted. Its group check leaves the
 * tree's runs out entirely, cost and hold alike: the tree's spend is
 * subtracted once, below, so counting it in the group too would charge it
 * twice, and the tree spends inside the root's hold, so counting that hold
 * would leave the tree nothing. It also leaves out holds of runs that started
 * after the root (they already counted the root's hold). capUsd is therefore
 * the tree's whole ceiling, and remainingUsd = capUsd - spentUsd - live
 * sibling holds. remainingUsd also nets the unspent holds of in-flight
 * sibling branches (parallel delegations, siblingHoldsUsd).
 */
export async function computeRunTreeSpend(
  db: BudgetGroupsDb,
  parentRunId: string,
  now: Date = new Date(),
): Promise<RunTreeSpend> {
  const { rootRunId, capUsd, spentUsd, remainingUsd } = await runTreeSpend(db, parentRunId, now);
  return { rootRunId, capUsd, spentUsd, remainingUsd };
}

interface TreeSpendDetail extends RunTreeSpend {
  treeRunIds: string[];
  root: RunOrder;
  rootBudgetGroupId: string | null;
}

interface TreeRow {
  id: string;
  parentRunId: string | null;
  status: string;
  costUsd: unknown;
  startedAt: Date;
  heartbeatAt: Date | null;
  agent: { budgetUsd: unknown };
  codingRun: { budgetReservedUsd: unknown; timeoutSec: number } | null;
}

/**
 * The unspent holds of the tree's in-flight runs beside the asking run: every
 * live run (isHoldLive) not on its ancestor chain -- siblings of the asking
 * run or of an ancestor, and everything below them. Sequential delegation
 * never has one; parallel delegations do, and without this each concurrent
 * child would claim the same remainder. Each run holds its own reservation (a
 * coding run's CodingRun.budgetReservedUsd, a native run's agent budgetUsd)
 * minus its own cost: a native branch's budgetUsd bounds only its own model
 * spend, so a coding grandchild under it holds its reservation separately. A
 * finished run holds nothing and counts its real spend only, so the tree's
 * remainder rises when a sibling finishes. With `self`, only runs that
 * started before it count (first come, first served, as in computeGroupSpend).
 */
function siblingHoldsUsd(rows: readonly TreeRow[], parentRunId: string, now: Date, self: RunOrder | undefined): number {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ancestors = new Set<string>();
  for (let id: string | null = parentRunId; id && !ancestors.has(id); id = byId.get(id)?.parentRunId ?? null) {
    ancestors.add(id);
  }
  const queueTimeoutSec = loadCodingConcurrencyConfig().queueTimeoutSec;
  let total = 0;
  for (const r of rows) {
    if (ancestors.has(r.id)) continue;
    if (self && (r.id === self.id || !isOrderedBefore(r, self))) continue;
    if (!isHoldLive(r, now, queueTimeoutSec)) continue;
    const reservation = r.codingRun ? Number(r.codingRun.budgetReservedUsd) : Number(r.agent.budgetUsd);
    total += Math.max(0, reservation - Number(r.costUsd));
  }
  return total;
}

/**
 * With `withOverrun` (coding dispatch), the tree's ceiling is the root
 * agent's budgetUsd raised by its own allowedOverrunPercent, still capped by
 * the root's budget group; without it (native callers), today's ceiling.
 */
async function runTreeSpend(
  db: BudgetGroupsDb,
  parentRunId: string,
  now: Date,
  self?: RunOrder,
  withOverrun = false,
): Promise<TreeSpendDetail> {
  const root = await findRootRun(db, parentRunId);
  const treeRunIds = await collectTreeRunIds(db, root.id);
  const rows: TreeRow[] = await db.run.findMany({
    where: { id: { in: treeRunIds } },
    select: {
      id: true,
      parentRunId: true,
      status: true,
      costUsd: true,
      startedAt: true,
      heartbeatAt: true,
      agent: { select: { budgetUsd: true } },
      codingRun: { select: { budgetReservedUsd: true, timeoutSec: true } },
    },
  });
  const spentUsd = rows.reduce((sum, r) => sum + Number(r.costUsd), 0);
  const heldUsd = siblingHoldsUsd(rows, parentRunId, now, self);

  const rootAgent = await db.agent.findUniqueOrThrow({
    where: { id: root.agentId },
    select: { id: true, budgetGroupId: true, budgetUsd: true, allowedOverrunPercent: true },
  });
  const rootOrder = { id: root.id, startedAt: root.startedAt };
  // Root has no parentRunId of its own, so this terminates in one level —
  // no unbounded recursion regardless of how deep `parentRunId` itself was.
  const rootCeiling = await groupCappedBudget(
    db,
    rootAgent,
    now,
    { excludeRunIds: treeRunIds, holdsBefore: rootOrder },
    undefined,
    withOverrun ? rootAgent.allowedOverrunPercent : undefined,
  );

  const capUsd = rootCeiling.effectiveBudgetUsd;
  return {
    rootRunId: root.id,
    capUsd,
    spentUsd,
    remainingUsd: Math.max(0, capUsd - spentUsd - heldUsd),
    treeRunIds,
    root: rootOrder,
    rootBudgetGroupId: rootAgent.budgetGroupId,
  };
}

export type BudgetConstraint = Period | "run-tree";

export interface EffectiveBudgetResult {
  /**
   * The ceiling to use. With EffectiveBudgetOptions.overrunPercent this is the
   * run's limit: its own budgetUsd raised by the overrun, then tightened.
   */
  effectiveBudgetUsd: number;
  /**
   * Set only when an overrun was requested: the agent's own budgetUsd
   * tightened by the same constraints, without the overrun (<= effectiveBudgetUsd).
   */
  baseBudgetUsd?: number;
  /** Which constraint(s), if any, are tighter than the agent's own budgetUsd right now. */
  constrainedBy: BudgetConstraint[];
  /** The first constraint with nothing left (< MIN_RESERVATION_USD), set only when there is one. */
  exhaustedBy?: BudgetConstraint;
  /** The constraint whose value equals effectiveBudgetUsd, when that is below the agent's own budget. */
  limitedBy?: BudgetConstraint;
  /** The numbers behind exhaustedBy, for the dispatch refusal record. */
  exhaustedDetail?: { capUsd: number; spentUsd: number; heldUsd: number; heldRuns: number };
}

interface BudgetCandidate {
  value: number;
  reason: BudgetConstraint;
  detail: { capUsd: number; spentUsd: number; heldUsd: number; heldRuns: number };
}

export interface EffectiveBudgetOptions {
  /**
   * The run this budget is for, when its row already exists (a native run's
   * load step): its own hold is not counted against itself, and neither are
   * the holds of runs that started after it (first come, first served).
   */
  self?: RunOrder;
  /**
   * Coding dispatch only: the agent's allowedOverrunPercent. The limit
   * (effectiveBudgetUsd) starts from budgetUsd x (1 + p/100) instead of
   * budgetUsd, the run tree's ceiling takes the root agent's own overrun, and
   * baseBudgetUsd reports the budget without it. Group and run-tree remainders
   * still cap both. Omitted (native callers): today's numbers exactly.
   */
  overrunPercent?: number;
}

/**
 * The per-run budget ceiling to actually use for `agent`: its own
 * budgetUsd, tightened to whatever's left of its budget group's
 * daily/weekly/monthly caps (whichever are set) AND, when `parentRunId` is
 * given (this run was dispatched as a sub-agent — see AgentSubAgent),
 * whatever's left of its run tree's shared ceiling. These are independent,
 * composable constraints: the final ceiling is the minimum of all that
 * apply, never one replacing another. An ungrouped, top-level agent run
 * with no caps configured is returned unchanged. Also logs a warning
 * (never blocks, never throws) once a period's spend crosses the group's
 * own warnThresholdRatio.
 *
 * A sub-agent in the root's own budget group spends inside the root's hold,
 * so its group check is the root's: the tree's holds and the holds of runs
 * after the root are left out. A sub-agent in any other group is an
 * ordinary member of that group and counts every earlier live hold there,
 * the tree's included.
 */
export async function effectiveBudgetForRun(
  db: BudgetGroupsDb,
  agent: Pick<Agent, "id" | "budgetGroupId" | "budgetUsd">,
  now: Date = new Date(),
  parentRunId?: string,
  options: EffectiveBudgetOptions = {},
): Promise<EffectiveBudgetResult> {
  const { self, overrunPercent } = options;
  const ownSpend: SpendOptions = { excludeReservationRunIds: self ? [self.id] : [], holdsBefore: self };
  if (!parentRunId) return groupCappedBudget(db, agent, now, ownSpend, undefined, overrunPercent);

  const tree = await runTreeSpend(db, parentRunId, now, self, overrunPercent !== undefined);
  const sharesRootGroup = agent.budgetGroupId !== null && agent.budgetGroupId === tree.rootBudgetGroupId;
  const spend: SpendOptions = sharesRootGroup
    ? { excludeReservationRunIds: [...tree.treeRunIds, ...(self ? [self.id] : [])], holdsBefore: tree.root }
    : ownSpend;
  return groupCappedBudget(
    db,
    agent,
    now,
    spend,
    {
      value: tree.remainingUsd,
      reason: "run-tree",
      detail: {
        capUsd: tree.capUsd,
        spentUsd: tree.spentUsd,
        heldUsd: tree.capUsd - tree.spentUsd - tree.remainingUsd,
        heldRuns: 0,
      },
    },
    overrunPercent,
  );
}

async function groupCappedBudget(
  db: BudgetGroupsDb,
  agent: Pick<Agent, "id" | "budgetGroupId" | "budgetUsd">,
  now: Date,
  spendOptions: SpendOptions,
  extra?: BudgetCandidate,
  overrunPercent?: number,
): Promise<EffectiveBudgetResult> {
  const ownBudgetUsd = Number(agent.budgetUsd);
  // The limit the candidates tighten: own raised by the overrun, when one was requested.
  const ownLimitUsd = overrunPercent === undefined ? ownBudgetUsd : (ownBudgetUsd * (100 + overrunPercent)) / 100;
  const base = (values: number[]) =>
    overrunPercent === undefined ? {} : { baseBudgetUsd: Math.min(ownBudgetUsd, ...values) };
  const candidates: BudgetCandidate[] = [];

  if (agent.budgetGroupId) {
    const group = await db.budgetGroup.findUnique({
      where: { id: agent.budgetGroupId },
      include: { agents: { select: { id: true, budgetUsd: true } } },
    });
    if (group) {
      const spend = await computeGroupSpend(db, group, group.agents, now, spendOptions);
      const warnThresholdRatio = Number(group.warnThresholdRatio);
      for (const s of spend) {
        candidates.push({
          value: s.remainingUsd,
          reason: s.period,
          detail: { capUsd: s.capUsd, spentUsd: s.spentUsd, heldUsd: s.reservedUsd, heldRuns: s.heldRuns },
        });
        if (s.spentUsd >= s.capUsd * warnThresholdRatio) {
          budgetGroupLog.warn(
            { groupId: group.id, groupName: group.name, period: s.period, capUsd: s.capUsd, spentUsd: s.spentUsd },
            `budget group "${group.name}"'s ${s.period} spend ($${s.spentUsd.toFixed(4)}) has reached ` +
              `${(warnThresholdRatio * 100).toFixed(0)}% of its $${s.capUsd.toFixed(4)} cap`,
          );
        }
      }
    }
  }

  if (extra) candidates.push(extra);

  if (candidates.length === 0) return { effectiveBudgetUsd: ownLimitUsd, ...base([]), constrainedBy: [] };

  const values = candidates.map((c) => c.value);
  const constrainedBy = candidates.filter((c) => c.value < ownLimitUsd).map((c) => c.reason);
  const effectiveBudgetUsd = Math.min(ownLimitUsd, ...values);
  // Less than the smallest reservable amount is nothing left.
  const exhausted = candidates.find((c) => c.value < MIN_RESERVATION_USD);
  const limiting =
    effectiveBudgetUsd < ownLimitUsd ? candidates.find((c) => c.value === effectiveBudgetUsd) : undefined;
  return {
    effectiveBudgetUsd,
    ...base(values),
    constrainedBy,
    ...(limiting ? { limitedBy: limiting.reason } : {}),
    ...(exhausted ? { exhaustedBy: exhausted.reason, exhaustedDetail: exhausted.detail } : {}),
  };
}
