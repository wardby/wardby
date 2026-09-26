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
            codingRun: { select: { budgetReservedUsd: true, timeoutSec: true } },
          },
        });

  const accounted = runs.map((r) => {
    const costUsd = Number(r.costUsd);
    let reservedUsd = 0;
    const holds =
      !excluded.has(r.id) &&
      (options.holdsBefore === undefined || isOrderedBefore(r, options.holdsBefore)) &&
      isHoldLive(r, now, queueTimeoutSec);
    if (holds) {
      // A coding run holds exactly what dispatch reserved. A native run (or
      // a coding run whose CodingRun row is missing) holds its agent's
      // per-run budget: never less than what it can actually spend.
      const reservation =
        r.codingRun != null ? Number(r.codingRun.budgetReservedUsd) : (memberBudgets.get(r.agentId) ?? 0);
      reservedUsd = Math.max(0, reservation - costUsd);
    }
    return { startedAt: r.startedAt, costUsd, reservedUsd };
  });

  return configured.map(({ period, capUsd }) => {
    const start = periodStart(period, now);
    const inPeriod = accounted.filter((r) => r.startedAt >= start);
    const spentUsd = inPeriod.reduce((sum, r) => sum + r.costUsd, 0);
    const reservedUsd = inPeriod.reduce((sum, r) => sum + r.reservedUsd, 0);
    return { period, capUsd, spentUsd, reservedUsd, remainingUsd: Math.max(0, capUsd - spentUsd - reservedUsd) };
  });
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
 * the root's own effective budget (its own budgetUsd, itself tightened by
 * its own BudgetGroup if any) minus everything every run in the tree has
 * spent so far. The root's ceiling is recomputed fresh here, not pinned
 * from whatever it was when the root run started — consistent with
 * BudgetGroup periods already always being live-recomputed rather than
 * snapshotted. That group check sees the group as the root did when it
 * loaded: the tree's own holds are left out (the tree spends inside the
 * root's hold, so counting it again would leave the tree nothing), and so
 * are holds of runs that started after the root (they already counted the
 * root's hold).
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

async function runTreeSpend(db: BudgetGroupsDb, parentRunId: string, now: Date): Promise<TreeSpendDetail> {
  const root = await findRootRun(db, parentRunId);
  const treeRunIds = await collectTreeRunIds(db, root.id);
  const rows = await db.run.findMany({ where: { id: { in: treeRunIds } }, select: { costUsd: true } });
  const spentUsd = rows.reduce((sum, r) => sum + Number(r.costUsd), 0);

  const rootAgent = await db.agent.findUniqueOrThrow({
    where: { id: root.agentId },
    select: { id: true, budgetGroupId: true, budgetUsd: true },
  });
  const rootOrder = { id: root.id, startedAt: root.startedAt };
  // Root has no parentRunId of its own, so this terminates in one level —
  // no unbounded recursion regardless of how deep `parentRunId` itself was.
  const rootCeiling = await groupCappedBudget(db, rootAgent, now, {
    excludeReservationRunIds: treeRunIds,
    holdsBefore: rootOrder,
  });

  const capUsd = rootCeiling.effectiveBudgetUsd;
  return {
    rootRunId: root.id,
    capUsd,
    spentUsd,
    remainingUsd: Math.max(0, capUsd - spentUsd),
    treeRunIds,
    root: rootOrder,
    rootBudgetGroupId: rootAgent.budgetGroupId,
  };
}

export type BudgetConstraint = Period | "run-tree";

export interface EffectiveBudgetResult {
  effectiveBudgetUsd: number;
  /** Which constraint(s), if any, are tighter than the agent's own budgetUsd right now. */
  constrainedBy: BudgetConstraint[];
  /** The first constraint with nothing left (< MIN_RESERVATION_USD), set only when there is one. */
  exhaustedBy?: BudgetConstraint;
}

export interface EffectiveBudgetOptions {
  /**
   * The run this budget is for, when its row already exists (a native run's
   * load step): its own hold is not counted against itself, and neither are
   * the holds of runs that started after it (first come, first served).
   */
  self?: RunOrder;
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
  const self = options.self;
  const ownSpend: SpendOptions = { excludeReservationRunIds: self ? [self.id] : [], holdsBefore: self };
  if (!parentRunId) return groupCappedBudget(db, agent, now, ownSpend);

  const tree = await runTreeSpend(db, parentRunId, now);
  const sharesRootGroup = agent.budgetGroupId !== null && agent.budgetGroupId === tree.rootBudgetGroupId;
  const spend: SpendOptions = sharesRootGroup
    ? { excludeReservationRunIds: [...tree.treeRunIds, ...(self ? [self.id] : [])], holdsBefore: tree.root }
    : ownSpend;
  return groupCappedBudget(db, agent, now, spend, { value: tree.remainingUsd, reason: "run-tree" });
}

async function groupCappedBudget(
  db: BudgetGroupsDb,
  agent: Pick<Agent, "id" | "budgetGroupId" | "budgetUsd">,
  now: Date,
  spendOptions: SpendOptions,
  extra?: { value: number; reason: BudgetConstraint },
): Promise<EffectiveBudgetResult> {
  const ownBudgetUsd = Number(agent.budgetUsd);
  const candidates: { value: number; reason: BudgetConstraint }[] = [];

  if (agent.budgetGroupId) {
    const group = await db.budgetGroup.findUnique({
      where: { id: agent.budgetGroupId },
      include: { agents: { select: { id: true, budgetUsd: true } } },
    });
    if (group) {
      const spend = await computeGroupSpend(db, group, group.agents, now, spendOptions);
      const warnThresholdRatio = Number(group.warnThresholdRatio);
      for (const s of spend) {
        candidates.push({ value: s.remainingUsd, reason: s.period });
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

  if (candidates.length === 0) return { effectiveBudgetUsd: ownBudgetUsd, constrainedBy: [] };

  const constrainedBy = candidates.filter((c) => c.value < ownBudgetUsd).map((c) => c.reason);
  const effectiveBudgetUsd = Math.min(ownBudgetUsd, ...candidates.map((c) => c.value));
  // Less than the smallest reservable amount is nothing left.
  const exhausted = candidates.find((c) => c.value < MIN_RESERVATION_USD);
  return { effectiveBudgetUsd, constrainedBy, ...(exhausted ? { exhaustedBy: exhausted.reason } : {}) };
}
