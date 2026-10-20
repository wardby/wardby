/**
 * The record of a budget refusal (by the coding proxy, or at dispatch) with
 * its numbers and the limit that bound it, and the sentences later surfaces
 * build from it. Details hold amounts, the model and the turn; never secrets
 * or message text.
 */
import type { Prisma, PrismaClient } from "#prisma";
import { logger } from "./logger.js";
import { groupName, overrunPercent } from "./budget-wording.js";

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
  /** How the refused hold was priced, and its worst case; absent on records from before cache-aware holds. */
  refusedHoldBasis?: "cached" | "full";
  refusedHoldCeilingUsd?: number;
  model: string;
  /** Completed (incl. estimated) requests + 1. */
  turn: number;
  /** Filled at read time (budget event names); never stored, and dropped if a stored row has them. */
  agentBudgetUsd?: number;
  /** Filled at read time: the run's budget before its allowed overrun, when the agent had one. */
  baseBudgetUsd?: number;
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

/**
 * A coding run's overrun top-up its budget group or run tree had no room for
 * (budget-topup.ts). Written by the control plane; the numbers are those of
 * the limiting cap or tree, and the run's base, grant and limit.
 */
export interface TopUpRefusalDetails {
  source: "top-up";
  capUsd: number;
  spentUsd: number;
  heldUsd: number;
  /** What the group or tree had left. */
  leftUsd: number;
  baseBudgetUsd: number;
  /** What the run had been granted: its base plus the top-ups so far. */
  grantedUsd: number;
  limitUsd: number;
  /** The group whose cap was full, for a period limit (it can be the lead's group, not the run's). */
  groupName?: string;
  /** Filled at read time, for a run-tree limit. */
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
  const left = Math.max(0, details.budgetUsd - details.spentUsd - held);
  const heldPart = held > 0 ? `, ${usd(held)} held by requests in flight` : "";
  const percent = overrunPercent(details.baseBudgetUsd, details.budgetUsd);
  const budget =
    percent !== null && details.baseBudgetUsd !== undefined
      ? `${usd(details.baseBudgetUsd)} budget and its ${percent}% allowed overrun (${usd(details.budgetUsd)} in all)`
      : `${usd(details.budgetUsd)} budget`;
  return (
    `${subject} needed a ${usd(details.refusedHoldUsd)} hold, but only ${usd(left)} of this run's ` +
    `${budget} was left (${usd(details.spentUsd)} spent${heldPart}).`
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
  if (limit === "run") {
    const overran = overrunPercent(details.baseBudgetUsd, details.budgetUsd) !== null;
    return `${first} To continue, raise ${overran ? "budgetUsd or allowedOverrunPercent" : "budgetUsd"} on ${agentName}.`;
  }
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

const BUDGET_LIMITS: ReadonlySet<string> = new Set<BudgetLimit>(["run", "run-tree", "day", "week", "month"]);
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/**
 * A proxy refusal rebuilt from only its stored amounts, model and turn, or
 * null when any is missing or malformed. The proxy (a less-trusted role)
 * writes the source record, so nothing else it wrote is kept: names are
 * filled at read time from the database.
 */
export function proxyRefusalDetails(raw: unknown): ProxyRefusalDetails | null {
  if (!isRecord(raw)) return null;
  const { budgetUsd, spentUsd, heldReservedUsd, heldUncertainUsd, refusedHoldUsd, turn, model } = raw;
  if (![budgetUsd, spentUsd, heldReservedUsd, heldUncertainUsd, refusedHoldUsd].every(isFiniteNumber)) return null;
  if (!isCount(turn) || typeof model !== "string" || !MODEL_ID.test(model)) return null;
  const result: ProxyRefusalDetails = {
    source: "proxy",
    budgetUsd: budgetUsd as number,
    spentUsd: spentUsd as number,
    heldReservedUsd: heldReservedUsd as number,
    heldUncertainUsd: heldUncertainUsd as number,
    refusedHoldUsd: refusedHoldUsd as number,
    model,
    turn,
  };
  const basis = raw.refusedHoldBasis;
  const ceiling = raw.refusedHoldCeilingUsd;
  return {
    ...result,
    ...(basis === "cached" || basis === "full" ? { refusedHoldBasis: basis } : {}),
    ...(isFiniteNumber(ceiling) ? { refusedHoldCeilingUsd: ceiling } : {}),
  };
}

/** A dispatch refusal rebuilt from only its stored amounts, or null when any is missing or malformed. */
function dispatchRefusalDetails(raw: Record<string, unknown>): DispatchRefusalDetails | null {
  const { capUsd, spentUsd, heldUsd, heldRuns } = raw;
  if (![capUsd, spentUsd, heldUsd].every(isFiniteNumber) || !isCount(heldRuns)) return null;
  return {
    source: "dispatch",
    capUsd: capUsd as number,
    spentUsd: spentUsd as number,
    heldUsd: heldUsd as number,
    heldRuns,
  };
}

/** A stored row as a view, or null when its limit or details fail the shape check (so no sentence can throw). */
function budgetEventView(row: { limit: string; at: Date; details: unknown }): BudgetEventView | null {
  if (!BUDGET_LIMITS.has(row.limit) || !isRecord(row.details)) return null;
  const details =
    row.details.source === "proxy"
      ? proxyRefusalDetails(row.details)
      : row.details.source === "dispatch"
        ? dispatchRefusalDetails(row.details)
        : null;
  if (!details) return null;
  return { kind: "refused", limit: row.limit as BudgetLimit, at: row.at.toISOString(), details };
}

/** The run's latest well-formed budget event, or null. Never throws. */
export async function latestBudgetEvent(
  db: Pick<PrismaClient, "runBudgetEvent">,
  runId: string,
): Promise<BudgetEventView | null> {
  try {
    const row = await db.runBudgetEvent.findFirst({ where: { runId }, orderBy: { at: "desc" } });
    return row ? budgetEventView(row) : null;
  } catch (err) {
    log.warn({ err, runId }, "could not read the latest budget event");
    return null;
  }
}

/** What fills an event's names: the run's agent, its budget group, and (when asked for) the tree root. */
interface BudgetEventNames {
  agentName?: string;
  agentBudgetUsd?: number;
  baseBudgetUsd?: number;
  groupName?: string;
  leadAgentName?: string;
}

/**
 * Loads the run, its agent and budget group once and, when `withLead`, walks
 * `parentRunId` (bounded) to the tree root once.
 */
async function budgetEventNames(
  db: Pick<PrismaClient, "run">,
  runId: string,
  withLead: boolean,
): Promise<BudgetEventNames> {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: {
      parentRunId: true,
      agent: { select: { name: true, budgetUsd: true, budgetGroup: { select: { name: true } } } },
      codingRun: { select: { budgetBaseUsd: true } },
    },
  });
  const names: BudgetEventNames = {};
  if (!run) return names;
  if (run.agent) {
    names.agentName = run.agent.name;
    const budget = Number(run.agent.budgetUsd);
    if (Number.isFinite(budget)) names.agentBudgetUsd = budget;
    if (run.agent.budgetGroup?.name) names.groupName = run.agent.budgetGroup.name;
  }
  const base = run.codingRun?.budgetBaseUsd == null ? NaN : Number(run.codingRun.budgetBaseUsd);
  if (Number.isFinite(base)) names.baseBudgetUsd = base;
  if (withLead) {
    let lead = run.agent?.name;
    let id: string | null = run.parentRunId;
    for (let hops = 1; id && hops < 32; hops++) {
      const row: { parentRunId: string | null; agent: { name: string } | null } | null = await db.run.findUnique({
        where: { id },
        select: { parentRunId: true, agent: { select: { name: true } } },
      });
      if (!row) break;
      lead = row.agent?.name ?? lead;
      id = row.parentRunId;
    }
    if (lead) names.leadAgentName = lead;
  }
  return names;
}

/** The event with its names filled: the group, the agent budget (proxy refusals) and the lead (run-tree). */
function withNames(event: BudgetEventView, names: BudgetEventNames): BudgetEventView {
  const details: BudgetEventDetails = { ...event.details };
  if (names.groupName) details.groupName = names.groupName;
  if (details.source === "proxy" && names.agentBudgetUsd !== undefined) details.agentBudgetUsd = names.agentBudgetUsd;
  if (details.source === "proxy" && names.baseBudgetUsd !== undefined) details.baseBudgetUsd = names.baseBudgetUsd;
  if (event.limit === "run-tree" && names.leadAgentName) details.leadAgentName = names.leadAgentName;
  return { ...event, details };
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
    const names = await budgetEventNames(db, runId, event.limit === "run-tree");
    return { event: withNames(event, names), agentName: names.agentName ?? "this agent" };
  } catch (err) {
    log.warn({ err, runId }, "could not load the budget event");
    return null;
  }
}

/**
 * Every well-formed budget event of the run, oldest first, with names filled
 * in as loadBudgetEvent does (the run and tree are read once for all of
 * them). If the names cannot be read the events are returned without them.
 */
export async function loadBudgetEvents(
  db: Pick<PrismaClient, "run" | "runBudgetEvent">,
  runId: string,
): Promise<BudgetEventView[]> {
  const rows = await db.runBudgetEvent.findMany({ where: { runId }, orderBy: { at: "asc" } });
  const events = rows.map(budgetEventView).filter((event): event is BudgetEventView => event !== null);
  if (events.length === 0) return events;
  try {
    const names = await budgetEventNames(
      db,
      runId,
      events.some((event) => event.limit === "run-tree"),
    );
    return events.map((event) => withNames(event, names));
  } catch (err) {
    log.warn({ err, runId }, "could not read the budget event names");
    return events;
  }
}
