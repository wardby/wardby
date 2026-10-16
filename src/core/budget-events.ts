/**
 * The record of a budget refusal (by the coding proxy, or at dispatch) with
 * its numbers and the limit that bound it, and the sentences later surfaces
 * build from it. Details hold amounts, the model and the turn; never secrets
 * or message text.
 */
import type { Prisma, PrismaClient } from "#prisma";
import { logger } from "./logger.js";
import { groupName } from "./budget-wording.js";

const log = logger.child({ module: "budget-events" });

export type BudgetLimit = "run" | "run-tree" | "day" | "week" | "month";

/** A proxy refusal: the next model request's hold did not fit. */
export interface ProxyRefusalDetails {
  source: "proxy";
  budgetUsd: number;
  spentUsd: number;
  heldReservedUsd: number;
  heldUncertainUsd: number;
  refusedHoldUsd: number;
  model: string;
  /** Completed (incl. estimated) requests + 1. */
  turn: number;
  /** Filled at read time by loadBudgetEvent (Task 7); not stored by the proxy. */
  agentBudgetUsd?: number;
  groupName?: string;
  leadAgentName?: string;
}

/** A dispatch refusal: the group or run tree had nothing left. */
export interface DispatchRefusalDetails {
  source: "dispatch";
  capUsd: number;
  spentUsd: number;
  heldUsd: number;
  heldRuns: number;
  groupName?: string;
  leadAgentName?: string;
}

export type BudgetEventDetails = ProxyRefusalDetails | DispatchRefusalDetails;

export interface BudgetEventView {
  kind: "refused";
  limit: BudgetLimit;
  at: string;
  details: BudgetEventDetails;
}

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

const PERIOD_ADJECTIVE: Record<string, string> = { day: "daily", week: "weekly", month: "monthly" };

function periodAdjective(limit: BudgetLimit): string {
  return PERIOD_ADJECTIVE[limit] ?? limit;
}

/** `the "name" group`, or a neutral phrase when the name could not be read. */
function groupPhrase(details: BudgetEventDetails): string {
  const name = groupName(details.groupName);
  return name ? `the "${name}" group` : "the budget group";
}

/** What the proxy refused, and what was left: `{subject} needed a $X hold, but only $Y of ... was left (...)`. */
function proxyFacts(details: ProxyRefusalDetails, subject: string): string {
  const held = details.heldReservedUsd + details.heldUncertainUsd;
  const left = details.budgetUsd - details.spentUsd - held;
  const heldPart = held > 0 ? `, ${usd(held)} held by requests in flight` : "";
  return (
    `${subject} needed a ${usd(details.refusedHoldUsd)} hold, but only ${usd(left)} of this run's ` +
    `${usd(details.budgetUsd)} budget was left (${usd(details.spentUsd)} spent${heldPart}).`
  );
}

function periodCapSentence(limit: BudgetLimit, details: ProxyRefusalDetails): string {
  const phrase = groupPhrase(details);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}'s ${periodAdjective(limit)} cap limited this run to ${usd(details.budgetUsd)}.`;
}

function dispatchPeriodSentence(limit: BudgetLimit, details: DispatchRefusalDetails): string {
  const left = Math.max(0, details.capUsd - details.spentUsd - details.heldUsd);
  return (
    `${groupPhrase(details)} had ${usd(left)} left of its ${usd(details.capUsd)} ${periodAdjective(limit)} cap ` +
    `(${usd(details.spentUsd)} spent, ${usd(details.heldUsd)} held by ${details.heldRuns} running run(s)).`
  );
}

/** Sentence for the run owner (run error, lead's sub-agent result, get_run consumers). */
export function ownerBudgetSentence(event: BudgetEventView, agentName: string): string {
  const { details, limit } = event;
  if (details.source === "dispatch") {
    if (limit === "run-tree") {
      const lead = details.leadAgentName ?? "lead agent";
      return `Could not start: the lead's (${lead}) run tree had nothing left of its ${usd(details.capUsd)} budget (${usd(details.spentUsd)} spent).`;
    }
    return `Could not start: ${dispatchPeriodSentence(limit, details)}`;
  }
  const first = `Stopped before turn ${details.turn}: ${proxyFacts(details, "the next request")}`;
  if (limit === "run") return `${first} To continue, raise budgetUsd on ${agentName}.`;
  if (limit === "run-tree") {
    const lead = details.leadAgentName ?? "lead agent";
    return (
      `${first} The lead's (${lead}) remaining budget limited this run to ${usd(details.budgetUsd)}. ` +
      `To continue, raise budgetUsd on ${lead}.`
    );
  }
  return `${first} ${periodCapSentence(limit, details)} To continue, raise the group's ${periodAdjective(limit)} cap.`;
}

/** Sentence for a host comment: amounts and group name only. */
export function hostBudgetSentence(event: BudgetEventView): string {
  const { details, limit } = event;
  if (details.source === "dispatch") {
    if (limit === "run-tree") {
      return `Out of budget: could not start: the lead's run tree had nothing left of its ${usd(details.capUsd)} budget (${usd(details.spentUsd)} spent).`;
    }
    return `Out of budget: could not start: ${dispatchPeriodSentence(limit, details)}`;
  }
  const first = `Out of budget: ${proxyFacts(details, "the next model request")}`;
  if (limit === "run" || limit === "run-tree") return first;
  return `${first} ${periodCapSentence(limit, details)} To continue, raise the group's ${periodAdjective(limit)} cap.`;
}

/** Records a refusal; best effort, never throws (a record must not change the refusal). */
export async function recordBudgetEvent(
  db: Pick<PrismaClient, "runBudgetEvent">,
  runId: string,
  limit: BudgetLimit,
  details: BudgetEventDetails,
): Promise<void> {
  try {
    await db.runBudgetEvent.create({
      data: { runId, kind: "refused", limit, details: details as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    log.warn({ err, runId }, "could not record a budget event");
  }
}

/** The run's latest budget event, or null. Never throws. */
export async function latestBudgetEvent(
  db: Pick<PrismaClient, "runBudgetEvent">,
  runId: string,
): Promise<BudgetEventView | null> {
  try {
    const row = await db.runBudgetEvent.findFirst({ where: { runId }, orderBy: { at: "desc" } });
    if (!row) return null;
    return {
      kind: "refused",
      limit: row.limit as BudgetLimit,
      at: row.at.toISOString(),
      details: row.details as unknown as BudgetEventDetails,
    };
  } catch (err) {
    log.warn({ err, runId }, "could not read the latest budget event");
    return null;
  }
}

/** The tree root's agent name: walks `parentRunId` (bounded) from the run. */
async function rootAgentName(db: Pick<PrismaClient, "run">, runId: string): Promise<string | undefined> {
  let id: string | null = runId;
  let name: string | undefined;
  for (let hops = 0; id && hops < 32; hops++) {
    const row: { parentRunId: string | null; agent: { name: string } | null } | null = await db.run.findUnique({
      where: { id },
      select: { parentRunId: true, agent: { select: { name: true } } },
    });
    if (!row) break;
    name = row.agent?.name ?? name;
    id = row.parentRunId;
  }
  return name;
}

/**
 * The run's latest budget event with names filled in from its agent, budget
 * group and (for a run-tree limit) the tree root. Never throws; null when
 * there is none.
 */
export async function loadBudgetEvent(
  db: Pick<PrismaClient, "run" | "runBudgetEvent">,
  runId: string,
): Promise<{ event: BudgetEventView; agentName: string } | null> {
  try {
    const event = await latestBudgetEvent(db, runId);
    if (!event) return null;
    const run = await db.run.findUnique({
      where: { id: runId },
      select: { agent: { select: { name: true, budgetUsd: true, budgetGroup: { select: { name: true } } } } },
    });
    const details: BudgetEventDetails = { ...event.details };
    const group = run?.agent?.budgetGroup?.name;
    if (group && details.groupName === undefined) details.groupName = group;
    if (details.source === "proxy" && run?.agent && details.agentBudgetUsd === undefined) {
      const budget = Number(run.agent.budgetUsd);
      if (Number.isFinite(budget)) details.agentBudgetUsd = budget;
    }
    if (event.limit === "run-tree" && details.leadAgentName === undefined) {
      const lead = await rootAgentName(db, runId);
      if (lead) details.leadAgentName = lead;
    }
    return { event: { ...event, details }, agentName: run?.agent?.name ?? "this agent" };
  } catch (err) {
    log.warn({ err, runId }, "could not load the budget event");
    return null;
  }
}
