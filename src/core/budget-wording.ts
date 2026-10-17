/**
 * The one sentence a host (a PR comment, a check summary) is told when a run
 * ran out of budget, or could not start for lack of it. Public repositories
 * read these, so it names amounts and the budget group only: never error
 * text, token counts, or ids.
 */
import type { PrismaClient } from "#prisma";
import { hostBudgetSentence, loadBudgetEvent } from "./budget-events.js";

export interface BudgetFacts {
  /** The run's own budget (a coding run's reservation); falls back to the agent's. */
  runBudgetUsd?: number | null;
  agentBudgetUsd: number;
  /** The run's budget before the agent's allowed overrun; absent for runs from before the setting. */
  baseBudgetUsd?: number | null;
  budgetGroupName?: string | null;
  /** The run was refused before it started. */
  refused?: boolean;
}

const MAX_GROUP_NAME_CHARS = 64;

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

/** A group name is operator-chosen text; keep it to one short, quote-free line. */
export function groupName(name: string | null | undefined): string | null {
  const cleaned = (name ?? "").replace(/["`]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME_CHARS);
  return cleaned || null;
}

/** The allowed overrun as a whole percent, or null when the run had none (no base, or it rounds to 0%). */
export function overrunPercent(baseUsd: number | null | undefined, limitUsd: number): number | null {
  if (baseUsd == null || !(baseUsd > 0) || !(baseUsd < limitUsd)) return null;
  const percent = Math.round((limitUsd / baseUsd - 1) * 100);
  return percent > 0 ? percent : null;
}

export function budgetSentence(facts: BudgetFacts): string {
  const group = groupName(facts.budgetGroupName);
  if (facts.refused) {
    const within = `this run could not start within its ${usd(facts.runBudgetUsd ?? facts.agentBudgetUsd)} budget`;
    return group
      ? `Out of budget: ${within} or what the "${group}" budget group had left of its limit.`
      : `Out of budget: ${within}.`;
  }
  const runBudget = facts.runBudgetUsd ?? facts.agentBudgetUsd;
  const base = facts.baseBudgetUsd;
  const percent = overrunPercent(base, runBudget);
  if (base != null && percent !== null) {
    return `Out of budget: this run's ${usd(base)} budget and its ${percent}% allowed overrun (${usd(runBudget)} in all) were used up.`;
  }
  const used = `Out of budget: this run's ${usd(runBudget)} budget was used up`;
  // A run reserved less than the agent's own budget: its group had only that much left.
  if (group && runBudget < facts.agentBudgetUsd) {
    return `${used} (the "${group}" budget group had only that much left of its limit).`;
  }
  return `${used}.`;
}

/**
 * For a run that finished over its base budget: what it spent and by how much
 * it went over, and whether that stayed inside the allowed overrun. Undefined
 * when the spend is within the base budget.
 */
export function overrunSentence(costUsd: number, baseUsd: number, limitUsd: number): string | undefined {
  if (!(baseUsd > 0) || !(costUsd > baseUsd)) return undefined;
  const over = costUsd - baseUsd;
  const percent = Math.round((over / baseUsd) * 100);
  const within = costUsd <= limitUsd ? ", within its allowed overrun" : "";
  return `Spent ${usd(costUsd)}, ${usd(over)} (${percent}%) over its ${usd(baseUsd)} budget${within}.`;
}

/**
 * The sentence for a finished run, read from the database: a coding run's
 * reserved budget, otherwise the agent's. Falls back to a sentence without
 * amounts when they cannot be read. Never throws.
 */
export async function loadBudgetSentence(
  db: Pick<PrismaClient, "run" | "runBudgetEvent">,
  runId: string,
  status: string,
): Promise<string> {
  const loaded = await loadBudgetEvent(db, runId);
  if (loaded) return hostBudgetSentence(loaded.event);
  const refused = status === "refused";
  try {
    const row = await db.run.findUnique({
      where: { id: runId },
      select: {
        agent: { select: { budgetUsd: true, budgetGroup: { select: { name: true } } } },
        codingRun: { select: { budgetReservedUsd: true, budgetBaseUsd: true } },
      },
    });
    const agentBudgetUsd = Number(row?.agent?.budgetUsd);
    if (!row?.agent || !Number.isFinite(agentBudgetUsd)) throw new Error("budget_facts_unavailable");
    const reserved = row.codingRun ? Number(row.codingRun.budgetReservedUsd) : NaN;
    const base = row.codingRun?.budgetBaseUsd == null ? NaN : Number(row.codingRun.budgetBaseUsd);
    return budgetSentence({
      runBudgetUsd: Number.isFinite(reserved) ? reserved : null,
      baseBudgetUsd: Number.isFinite(base) ? base : null,
      agentBudgetUsd,
      budgetGroupName: row.agent.budgetGroup?.name ?? null,
      refused,
    });
  } catch {
    return refused
      ? "Out of budget: this run could not start within its budget."
      : "Out of budget: this run's budget was used up.";
  }
}
