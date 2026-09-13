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
 * like any other zero/negative budget.
 */
import type { Agent, BudgetGroup, PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

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
  spentUsd: number;
  remainingUsd: number;
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
  memberAgentIds: string[],
  now: Date = new Date(),
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
  const runs =
    memberAgentIds.length === 0
      ? []
      : await db.run.findMany({
          where: { agentId: { in: memberAgentIds }, startedAt: { gte: widestStart } },
          select: { costUsd: true, startedAt: true },
        });

  return configured.map(({ period, capUsd }) => {
    const start = periodStart(period, now);
    const spentUsd = runs.filter((r) => r.startedAt >= start).reduce((sum, r) => sum + Number(r.costUsd), 0);
    return { period, capUsd, spentUsd, remainingUsd: Math.max(0, capUsd - spentUsd) };
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
): Promise<{ id: string; agentId: string; parentRunId: string | null }> {
  let current = await db.run.findUniqueOrThrow({
    where: { id: runId },
    select: { id: true, agentId: true, parentRunId: true },
  });
  while (current.parentRunId) {
    current = await db.run.findUniqueOrThrow({
      where: { id: current.parentRunId },
      select: { id: true, agentId: true, parentRunId: true },
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
 * Real-time shared budget scope for a sub-agent dispatch (see
 * docs/private/2026-09-13-agent-subagent-design-and-plan.md §4): the whole
 * run tree rooted at `parentRunId`'s ultimate ancestor shares one ceiling —
 * the root's own effective budget (its own budgetUsd, itself tightened by
 * its own BudgetGroup if any) minus everything every run in the tree has
 * spent so far. The root's ceiling is recomputed fresh here, not pinned
 * from whatever it was when the root run started — consistent with
 * BudgetGroup periods already always being live-recomputed rather than
 * snapshotted.
 */
export async function computeRunTreeSpend(
  db: BudgetGroupsDb,
  parentRunId: string,
  now: Date = new Date(),
): Promise<RunTreeSpend> {
  const root = await findRootRun(db, parentRunId);
  const treeRunIds = await collectTreeRunIds(db, root.id);
  const rows = await db.run.findMany({ where: { id: { in: treeRunIds } }, select: { costUsd: true } });
  const spentUsd = rows.reduce((sum, r) => sum + Number(r.costUsd), 0);

  const rootAgent = await db.agent.findUniqueOrThrow({
    where: { id: root.agentId },
    select: { id: true, budgetGroupId: true, budgetUsd: true },
  });
  // Root has no parentRunId of its own, so this terminates in one level —
  // no unbounded recursion regardless of how deep `parentRunId` itself was.
  const rootCeiling = await effectiveBudgetForRun(db, rootAgent, now);

  const capUsd = rootCeiling.effectiveBudgetUsd;
  return { rootRunId: root.id, capUsd, spentUsd, remainingUsd: Math.max(0, capUsd - spentUsd) };
}

export interface EffectiveBudgetResult {
  effectiveBudgetUsd: number;
  /** Which constraint(s), if any, are tighter than the agent's own budgetUsd right now. */
  constrainedBy: (Period | "run-tree")[];
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
 */
export async function effectiveBudgetForRun(
  db: BudgetGroupsDb,
  agent: Pick<Agent, "id" | "budgetGroupId" | "budgetUsd">,
  now: Date = new Date(),
  parentRunId?: string,
): Promise<EffectiveBudgetResult> {
  const ownBudgetUsd = Number(agent.budgetUsd);
  const candidates: { value: number; reason: Period | "run-tree" }[] = [];

  if (agent.budgetGroupId) {
    const group = await db.budgetGroup.findUnique({
      where: { id: agent.budgetGroupId },
      include: { agents: { select: { id: true } } },
    });
    if (group) {
      const spend = await computeGroupSpend(
        db,
        group,
        group.agents.map((a) => a.id),
        now,
      );
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

  if (parentRunId) {
    const tree = await computeRunTreeSpend(db, parentRunId, now);
    candidates.push({ value: tree.remainingUsd, reason: "run-tree" });
  }

  if (candidates.length === 0) return { effectiveBudgetUsd: ownBudgetUsd, constrainedBy: [] };

  const constrainedBy = candidates.filter((c) => c.value < ownBudgetUsd).map((c) => c.reason);
  const effectiveBudgetUsd = Math.min(ownBudgetUsd, ...candidates.map((c) => c.value));
  return { effectiveBudgetUsd, constrainedBy };
}
