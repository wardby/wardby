/**
 * The record of a budget refusal (by the coding proxy, or at dispatch), or of
 * an overrun top-up a coding run's group or run tree had no room for, with its
 * numbers and the limit that bound it, and the sentences later surfaces build
 * from it. Details hold amounts, the model, the turn and names; never secrets
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
  /** Filled at read time: the most the run could have been topped up to (CodingRun.budgetLimitUsd). */
  limitUsd?: number;
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

export type BudgetEventDetails = ProxyRefusalDetails | DispatchRefusalDetails | TopUpRefusalDetails;

/** An overrun_unavailable event, as a refusal that followed it carries it. */
export interface OverrunUnavailableView {
  limit: BudgetLimit;
  details: TopUpRefusalDetails;
}

export interface BudgetEventView {
  kind: "refused" | "overrun_unavailable";
  limit: BudgetLimit;
  at: string;
  details: BudgetEventDetails;
  /** On a proxy refusal (loadBudgetEvent): the run's overrun top-up that found no room before it. */
  overrun?: OverrunUnavailableView;
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

/** Below this, two amounts are the same (CodingRun's 6 decimal places). */
const SAME_USD = 0.000001;

/**
 * The run's budget as the proxy enforced it: its base, and how much of its
 * allowed overrun it had been granted. An older run without a recorded limit
 * had its whole overrun reserved, so its budget is the limit.
 */
function budgetPhrase(details: ProxyRefusalDetails): string {
  const granted = details.budgetUsd;
  const base = details.baseBudgetUsd;
  const percent = overrunPercent(base, details.limitUsd ?? granted);
  if (percent === null || base === undefined || granted <= base + SAME_USD) return `${usd(granted)} budget`;
  if (details.limitUsd === undefined || granted >= details.limitUsd - SAME_USD) {
    return `${usd(base)} budget and its ${percent}% allowed overrun (${usd(granted)} in all)`;
  }
  return `${usd(base)} budget and ${usd(granted - base)} of its ${percent}% allowed overrun (${usd(granted)} in all)`;
}

/** What the proxy refused, and what was left: `{subject} needed a $X hold, but only $Y of ... was left (...)`. */
function proxyFacts(details: ProxyRefusalDetails, subject: string): string {
  const held = details.heldReservedUsd + details.heldUncertainUsd;
  const left = Math.max(0, details.budgetUsd - details.spentUsd - held);
  const heldPart = held > 0 ? `, ${usd(held)} held by requests in flight` : "";
  const budget = budgetPhrase(details);
  return (
    `${subject} needed a ${usd(details.refusedHoldUsd)} hold, but only ${usd(left)} of this run's ` +
    `${budget} was left (${usd(details.spentUsd)} spent${heldPart}).`
  );
}

function periodCapSentence(limit: BudgetLimit, details: ProxyRefusalDetails): string {
  const phrase = groupPhrase(details);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}'s ${periodAdjective(limit)} cap limited this run to ${usd(details.budgetUsd)}.`;
}

/**
 * Why the run's allowed overrun was not (all) there: `Its 10% allowed overrun
 * wasn't available because the "X" group had nothing left of its daily cap.`,
 * or `Only $0.40 of its 10% allowed overrun was available because ...` when
 * the run got part of it. A top-up takes whatever room there is, so the run is
 * refused only once nothing is left.
 * `lead` names the lead for a run-tree limit (owner sentences only).
 */
function overrunUnavailableSentence(overrun: OverrunUnavailableView, lead?: string): string {
  const { details, limit } = overrun;
  const percent = overrunPercent(details.baseBudgetUsd, details.limitUsd);
  const allowed = `${percent === null ? "" : `${percent}% `}allowed overrun`;
  const where =
    limit === "run-tree" ? (lead ? `the lead's (${lead}) run tree` : "the lead's run tree") : groupPhrase(details);
  const of = limit === "run-tree" ? `of its ${usd(details.capUsd)} budget` : `of its ${periodAdjective(limit)} cap`;
  const got = details.grantedUsd - details.baseBudgetUsd;
  if (got >= SAME_USD)
    return `Only ${usd(got)} of its ${allowed} was available because ${where} had no more left ${of}.`;
  return `Its ${allowed} wasn't available because ${where} had nothing left ${of}.`;
}

/** What to raise when the overrun was what ran out: the full group's cap, or the lead's budget. */
function overrunContinueSentence(overrun: OverrunUnavailableView, lead: string): string {
  return overrun.limit === "run-tree"
    ? `To continue, raise budgetUsd on ${lead}.`
    : `To continue, raise the group's ${periodAdjective(overrun.limit)} cap.`;
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
  if (details.source === "top-up") {
    return overrunUnavailableSentence({ limit, details }, details.leadAgentName ?? "lead agent");
  }
  if (details.source === "dispatch") {
    if (limit === "run-tree") {
      const lead = details.leadAgentName ?? "lead agent";
      return `Could not start: the lead's (${lead}) run tree had nothing left of its ${usd(details.capUsd)} budget (${usd(details.spentUsd)} spent).`;
    }
    return `Could not start: ${dispatchPeriodSentence(limit, details)}`;
  }
  const lead = details.leadAgentName ?? event.overrun?.details.leadAgentName ?? "lead agent";
  const overrun = event.overrun ? ` ${overrunUnavailableSentence(event.overrun, lead)}` : "";
  const first = `Stopped before turn ${details.turn}: ${proxyFacts(details, "the next request")}${overrun}`;
  if (limit === "run") {
    if (event.overrun) return `${first} ${overrunContinueSentence(event.overrun, lead)}`;
    const overran = overrunPercent(details.baseBudgetUsd, details.limitUsd ?? details.budgetUsd) !== null;
    return `${first} To continue, raise ${overran ? "budgetUsd or allowedOverrunPercent" : "budgetUsd"} on ${agentName}.`;
  }
  if (limit === "run-tree") {
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
  if (details.source === "top-up") return `Out of budget: ${overrunUnavailableSentence({ limit, details })}`;
  if (details.source === "dispatch") {
    if (limit === "run-tree") {
      return `Out of budget: could not start: the lead's run tree had nothing left of its ${usd(details.capUsd)} budget (${usd(details.spentUsd)} spent).`;
    }
    return `Out of budget: could not start: ${dispatchPeriodSentence(limit, details)}`;
  }
  const overrun = event.overrun ? ` ${overrunUnavailableSentence(event.overrun)}` : "";
  const first = `Out of budget: ${proxyFacts(details, "the next model request")}${overrun}`;
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

/** A top-up refusal rebuilt from only its stored amounts and group name, or null when any is missing or malformed. */
function topUpRefusalDetails(raw: Record<string, unknown>): TopUpRefusalDetails | null {
  const { capUsd, spentUsd, heldUsd, leftUsd, baseBudgetUsd, grantedUsd, limitUsd, groupName } = raw;
  if (![capUsd, spentUsd, heldUsd, leftUsd, baseBudgetUsd, grantedUsd, limitUsd].every(isFiniteNumber)) return null;
  return {
    source: "top-up",
    capUsd: capUsd as number,
    spentUsd: spentUsd as number,
    heldUsd: heldUsd as number,
    leftUsd: leftUsd as number,
    baseBudgetUsd: baseBudgetUsd as number,
    grantedUsd: grantedUsd as number,
    limitUsd: limitUsd as number,
    ...(typeof groupName === "string" && groupName ? { groupName } : {}),
  };
}

/** A stored row as a view, or null when its limit or details fail the shape check (so no sentence can throw). */
function budgetEventView(row: { kind: string; limit: string; at: Date; details: unknown }): BudgetEventView | null {
  if (!BUDGET_LIMITS.has(row.limit) || !isRecord(row.details)) return null;
  const at = row.at.toISOString();
  const limit = row.limit as BudgetLimit;
  if (row.kind === "overrun_unavailable") {
    const details = row.details.source === "top-up" ? topUpRefusalDetails(row.details) : null;
    return details ? { kind: "overrun_unavailable", limit, at, details } : null;
  }
  if (row.kind !== "refused") return null;
  const details =
    row.details.source === "proxy"
      ? proxyRefusalDetails(row.details)
      : row.details.source === "dispatch"
        ? dispatchRefusalDetails(row.details)
        : null;
  if (!details) return null;
  return { kind: "refused", limit, at, details };
}

/** The run's latest well-formed budget event of `kind`, or null. Never throws. */
async function latestEvent(
  db: Pick<PrismaClient, "runBudgetEvent">,
  runId: string,
  kind: "refused" | "overrun_unavailable",
): Promise<BudgetEventView | null> {
  try {
    const row = await db.runBudgetEvent.findFirst({ where: { runId, kind }, orderBy: { at: "desc" } });
    return row ? budgetEventView(row) : null;
  } catch (err) {
    log.warn({ err, runId }, "could not read the latest budget event");
    return null;
  }
}

/** The run's latest well-formed budget refusal, or null. Never throws. */
export async function latestBudgetEvent(
  db: Pick<PrismaClient, "runBudgetEvent">,
  runId: string,
): Promise<BudgetEventView | null> {
  return latestEvent(db, runId, "refused");
}

/** What fills an event's names: the run's agent, its budget group, and (when asked for) the tree root. */
interface BudgetEventNames {
  agentName?: string;
  agentBudgetUsd?: number;
  baseBudgetUsd?: number;
  limitUsd?: number;
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
      codingRun: { select: { budgetBaseUsd: true, budgetLimitUsd: true } },
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
  const limit = run.codingRun?.budgetLimitUsd == null ? NaN : Number(run.codingRun.budgetLimitUsd);
  if (Number.isFinite(limit)) names.limitUsd = limit;
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

/**
 * The event with its names filled: the group, the agent budget (proxy refusals) and the lead (run-tree).
 * A top-up refusal keeps the group it recorded: the full cap can be the lead's group, not the run's.
 */
function withNames(event: BudgetEventView, names: BudgetEventNames): BudgetEventView {
  const details: BudgetEventDetails = { ...event.details };
  if (names.groupName && details.source !== "top-up") details.groupName = names.groupName;
  if (details.source === "proxy" && names.agentBudgetUsd !== undefined) details.agentBudgetUsd = names.agentBudgetUsd;
  if (details.source === "proxy" && names.baseBudgetUsd !== undefined) details.baseBudgetUsd = names.baseBudgetUsd;
  if (details.source === "proxy" && names.limitUsd !== undefined) details.limitUsd = names.limitUsd;
  if (event.limit === "run-tree" && names.leadAgentName) details.leadAgentName = names.leadAgentName;
  if (!event.overrun) return { ...event, details };
  const overrun: OverrunUnavailableView = { limit: event.overrun.limit, details: { ...event.overrun.details } };
  if (overrun.limit === "run-tree" && names.leadAgentName) overrun.details.leadAgentName = names.leadAgentName;
  return { ...event, details, overrun };
}

/**
 * The run's latest budget refusal with names filled in from its agent, budget
 * group and (for a run-tree limit) the tree root. A proxy refusal carries the
 * run's overrun_unavailable event, when its overrun top-up found no room.
 * Never throws; null when there is none.
 */
export async function loadBudgetEvent(
  db: Pick<PrismaClient, "run" | "runBudgetEvent">,
  runId: string,
): Promise<{ event: BudgetEventView; agentName: string } | null> {
  try {
    const refusal = await latestBudgetEvent(db, runId);
    if (!refusal) return null;
    const overrun = refusal.details.source === "proxy" ? await latestEvent(db, runId, "overrun_unavailable") : null;
    const event: BudgetEventView =
      overrun?.details.source === "top-up"
        ? { ...refusal, overrun: { limit: overrun.limit, details: overrun.details } }
        : refusal;
    const names = await budgetEventNames(db, runId, event.limit === "run-tree" || event.overrun?.limit === "run-tree");
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
