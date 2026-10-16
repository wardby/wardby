/**
 * The one sentence a host (a PR comment, a check summary) is told when a run
 * ran out of budget, or could not start for lack of it. Public repositories
 * read these, so it names amounts and the budget group only: never error
 * text, token counts, or ids.
 */
import type { PrismaClient } from "#prisma";

export interface BudgetFacts {
  /** The run's own budget (a coding run's reservation); falls back to the agent's. */
  runBudgetUsd?: number | null;
  agentBudgetUsd: number;
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

export function budgetSentence(facts: BudgetFacts): string {
  const group = groupName(facts.budgetGroupName);
  if (facts.refused) {
    const within = `this run could not start within its ${usd(facts.runBudgetUsd ?? facts.agentBudgetUsd)} budget`;
    return group
      ? `Out of budget: ${within} or what the "${group}" budget group had left of its limit.`
      : `Out of budget: ${within}.`;
  }
  const runBudget = facts.runBudgetUsd ?? facts.agentBudgetUsd;
  const used = `Out of budget: this run's ${usd(runBudget)} budget was used up`;
  // A run reserved less than the agent's own budget: its group had only that much left.
  if (group && runBudget < facts.agentBudgetUsd) {
    return `${used} (the "${group}" budget group had only that much left of its limit).`;
  }
  return `${used}.`;
}

/**
 * The sentence for a finished run, read from the database: a coding run's
 * reserved budget, otherwise the agent's. Falls back to a sentence without
 * amounts when they cannot be read. Never throws.
 */
export async function loadBudgetSentence(
  db: Pick<PrismaClient, "run">,
  runId: string,
  status: string,
): Promise<string> {
  const refused = status === "refused";
  try {
    const row = await db.run.findUnique({
      where: { id: runId },
      select: {
        agent: { select: { budgetUsd: true, budgetGroup: { select: { name: true } } } },
        codingRun: { select: { budgetReservedUsd: true } },
      },
    });
    const agentBudgetUsd = Number(row?.agent?.budgetUsd);
    if (!row?.agent || !Number.isFinite(agentBudgetUsd)) throw new Error("budget_facts_unavailable");
    const reserved = row.codingRun ? Number(row.codingRun.budgetReservedUsd) : NaN;
    return budgetSentence({
      runBudgetUsd: Number.isFinite(reserved) ? reserved : null,
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
