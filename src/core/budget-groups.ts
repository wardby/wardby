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

export type BudgetGroupsDb = Pick<PrismaClient, "budgetGroup" | "run">;

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
  if (configured.length === 0 || memberAgentIds.length === 0) return [];

  const widestStart = periodStart("month", now);
  const runs = await db.run.findMany({
    where: { agentId: { in: memberAgentIds }, startedAt: { gte: widestStart } },
    select: { costUsd: true, startedAt: true },
  });

  return configured.map(({ period, capUsd }) => {
    const start = periodStart(period, now);
    const spentUsd = runs.filter((r) => r.startedAt >= start).reduce((sum, r) => sum + Number(r.costUsd), 0);
    return { period, capUsd, spentUsd, remainingUsd: Math.max(0, capUsd - spentUsd) };
  });
}

export interface EffectiveBudgetResult {
  effectiveBudgetUsd: number;
  /** Which period(s), if any, are tighter than the agent's own budgetUsd right now. */
  constrainedBy: Period[];
}

/**
 * The per-run budget ceiling to actually use for `agent`: its own
 * budgetUsd, tightened to whatever's left of its budget group's
 * daily/weekly/monthly caps (whichever are set). An ungrouped agent (no
 * budgetGroupId), or one whose group has no caps configured, is returned
 * unchanged. Also logs a warning (never blocks, never throws) once a
 * period's spend crosses the group's own warnThresholdRatio.
 */
export async function effectiveBudgetForRun(
  db: BudgetGroupsDb,
  agent: Pick<Agent, "id" | "budgetGroupId" | "budgetUsd">,
  now: Date = new Date(),
): Promise<EffectiveBudgetResult> {
  const ownBudgetUsd = Number(agent.budgetUsd);
  if (!agent.budgetGroupId) return { effectiveBudgetUsd: ownBudgetUsd, constrainedBy: [] };

  const group = await db.budgetGroup.findUnique({
    where: { id: agent.budgetGroupId },
    include: { agents: { select: { id: true } } },
  });
  if (!group) return { effectiveBudgetUsd: ownBudgetUsd, constrainedBy: [] };

  const spend = await computeGroupSpend(
    db,
    group,
    group.agents.map((a) => a.id),
    now,
  );
  const warnThresholdRatio = Number(group.warnThresholdRatio);

  for (const s of spend) {
    if (s.spentUsd >= s.capUsd * warnThresholdRatio) {
      budgetGroupLog.warn(
        { groupId: group.id, groupName: group.name, period: s.period, capUsd: s.capUsd, spentUsd: s.spentUsd },
        `budget group "${group.name}"'s ${s.period} spend ($${s.spentUsd.toFixed(4)}) has reached ` +
          `${(warnThresholdRatio * 100).toFixed(0)}% of its $${s.capUsd.toFixed(4)} cap`,
      );
    }
  }

  const constrainedBy = spend.filter((s) => s.remainingUsd < ownBudgetUsd).map((s) => s.period);
  const effectiveBudgetUsd = Math.min(ownBudgetUsd, ...spend.map((s) => s.remainingUsd));
  return { effectiveBudgetUsd, constrainedBy };
}
