/**
 * Overrun from available room: a coding run reserves only its base budget at
 * dispatch, and may spend past it, up to its limit (CodingRun.budgetLimitUsd,
 * the base raised by the agent's allowedOverrunPercent), only out of room its
 * budget group and run tree still have when it needs it. Overrun is
 * permission, not a reservation.
 *
 * The control plane grants top-ups, never the proxy: the executor's per-run
 * monitor loop calls topUpCodingBudget while the run's job is running. A run
 * close to its grant (spent + held within one maximum request hold of it) is
 * granted one step, under the same group dispatch lock dispatch takes, by
 * raising CodingRun.budgetReservedUsd (what groups and run trees hold) and
 * CodingProxySession.budgetUsd (what the proxy enforces, re-read on every
 * request) together. When the group or tree has no room left, the run records
 * an overrun_unavailable budget event and never asks again; the proxy then
 * refuses it at its grant as it always has.
 */
import type { Prisma, PrismaClient } from "#prisma";
import type { TopUpRefusalDetails } from "./budget-events.js";
import { codingTopUpRoom, MIN_RESERVATION_USD } from "./budget-groups.js";
import {
  GROUP_DISPATCH_LOCK_SQL,
  isSerializationConflict,
  isTransactionUnavailable,
  PERSIST_ATTEMPTS,
} from "./dispatch.js";
import { logger } from "./logger.js";
import { CONTENDED_TX_MAX_WAIT_MS } from "./timing.js";

const topUpLog = logger.child({ module: "budget-topup" });

/**
 * not_needed: the run is not close to its grant yet. granted: one step was
 * added. unavailable: its group or run tree had no room; recorded once, and
 * the run stops asking. closed: nothing more to ask for (no limit, the limit
 * reached, already refused once, or the run or its proxy session is not active).
 */
export type TopUpOutcome = "not_needed" | "granted" | "unavailable" | "closed";

export interface TopUpResult {
  outcome: TopUpOutcome;
  /** The run's grant after this call, when it has a limit. */
  grantedUsd?: number;
}

/** Share of the base one step adds, unless one maximum request hold is more. */
export const TOP_UP_STEP_SHARE = 0.1;

type TopUpTx = Prisma.TransactionClient;

interface TopUpState {
  baseUsd: number;
  grantedUsd: number;
  limitUsd: number;
  sessionId: string;
  spentUsd: number;
  heldUsd: number;
  /** The largest worst-case hold of any request so far: the headroom, and the least step. */
  maxHoldUsd: number;
}

const roundMicro = (usd: number): number => Math.round(usd / MIN_RESERVATION_USD) * MIN_RESERVATION_USD;
const floorMicro = (usd: number): number => Math.floor(usd / MIN_RESERVATION_USD + 1e-6) * MIN_RESERVATION_USD;

/** The run's grant, limit and proxy-session totals, or the outcome when there is nothing to ask for. */
async function readState(db: TopUpTx | PrismaClient, runId: string): Promise<TopUpState | TopUpResult> {
  const coding = await db.codingRun.findUnique({
    where: { runId },
    select: {
      budgetReservedUsd: true,
      budgetBaseUsd: true,
      budgetLimitUsd: true,
      run: { select: { status: true } },
      proxySession: { select: { id: true, status: true } },
    },
  });
  if (!coding || coding.budgetLimitUsd == null) return { outcome: "closed" };
  const grantedUsd = Number(coding.budgetReservedUsd);
  const limitUsd = Number(coding.budgetLimitUsd);
  const result = { outcome: "closed", grantedUsd } as const;
  if (grantedUsd + MIN_RESERVATION_USD > limitUsd) return result;
  if (coding.run.status !== "running" && coding.run.status !== "pending") return result;
  if (!coding.proxySession || coding.proxySession.status !== "active") return result;
  const refused = await db.runBudgetEvent.findFirst({
    where: { runId, kind: "overrun_unavailable" },
    select: { id: true },
  });
  if (refused) return result;

  // Totals as the proxy ledger counts them (prisma-ledger.ts reserve).
  const totals = await db.$queryRaw<{ spent: unknown; held: unknown; maxHold: unknown }[]>`
    SELECT
      COALESCE(SUM(CASE
        WHEN "status" = 'completed' THEN "actualCostUsd"
        WHEN "status" = 'uncertain' AND "costEstimated" THEN "actualCostUsd"
        ELSE 0
      END), 0) AS "spent",
      COALESCE(SUM(CASE
        WHEN "status" = 'reserved' THEN "reservationUsd"
        WHEN "status" = 'uncertain' AND NOT "costEstimated" THEN "reservationUsd"
        ELSE 0
      END), 0) AS "held",
      COALESCE(MAX(COALESCE("ceilingUsd", "reservationUsd")), 0) AS "maxHold"
    FROM "CodingProxyRequest" WHERE "sessionId" = ${coding.proxySession.id}
  `;
  return {
    baseUsd: coding.budgetBaseUsd == null ? grantedUsd : Number(coding.budgetBaseUsd),
    grantedUsd,
    limitUsd,
    sessionId: coding.proxySession.id,
    spentUsd: Number(totals[0]?.spent ?? 0),
    heldUsd: Number(totals[0]?.held ?? 0),
    maxHoldUsd: Number(totals[0]?.maxHold ?? 0),
  };
}

/** Close to its grant: one more maximum request hold would not fit. */
function isClose(state: TopUpState): boolean {
  return state.spentUsd + state.heldUsd >= state.grantedUsd - state.maxHoldUsd;
}

async function grantOnce(tx: TopUpTx, runId: string, now: Date): Promise<TopUpResult> {
  // First statement: serializes with dispatch and every other top-up (see GROUP_DISPATCH_LOCK_SQL).
  await tx.$executeRawUnsafe(GROUP_DISPATCH_LOCK_SQL);
  const state = await readState(tx, runId);
  if ("outcome" in state) return state;
  if (!isClose(state)) return { outcome: "not_needed", grantedUsd: state.grantedUsd };

  const room = await codingTopUpRoom(tx, runId, now);
  const step = Math.max(TOP_UP_STEP_SHARE * state.baseUsd, state.maxHoldUsd);
  const grant = floorMicro(Math.min(step, state.limitUsd - state.grantedUsd, room.roomUsd));
  if (grant < MIN_RESERVATION_USD) {
    const details: TopUpRefusalDetails = {
      source: "top-up",
      capUsd: room.detail?.capUsd ?? 0,
      spentUsd: room.detail?.spentUsd ?? 0,
      heldUsd: room.detail?.heldUsd ?? 0,
      leftUsd: room.roomUsd,
      baseBudgetUsd: state.baseUsd,
      grantedUsd: state.grantedUsd,
      limitUsd: state.limitUsd,
      ...(room.groupName ? { groupName: room.groupName } : {}),
    };
    await tx.runBudgetEvent.create({
      data: {
        runId,
        kind: "overrun_unavailable",
        limit: room.limitedBy ?? "run",
        details: details as unknown as Prisma.InputJsonValue,
      },
    });
    return { outcome: "unavailable", grantedUsd: state.grantedUsd };
  }
  const grantedUsd = Math.min(state.limitUsd, roundMicro(state.grantedUsd + grant));
  await tx.codingRun.update({ where: { runId }, data: { budgetReservedUsd: grantedUsd } });
  await tx.codingProxySession.updateMany({
    where: { id: state.sessionId, status: "active" },
    data: { budgetUsd: grantedUsd },
  });
  return { outcome: "granted", grantedUsd };
}

/**
 * Grants the run one overrun step when it is close to its grant and its
 * budget group and run tree have room. Cheap when it is not close: that is
 * read without the lock. Retries serialization conflicts as dispatch does.
 */
export async function topUpCodingBudget(db: PrismaClient, runId: string, now: Date = new Date()): Promise<TopUpResult> {
  const state = await readState(db, runId);
  if ("outcome" in state) return state;
  if (!isClose(state)) return { outcome: "not_needed", grantedUsd: state.grantedUsd };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await db.$transaction((tx) => grantOnce(tx, runId, now), {
        isolationLevel: "Serializable",
        maxWait: CONTENDED_TX_MAX_WAIT_MS,
      });
      if (result.outcome === "granted" || result.outcome === "unavailable") {
        topUpLog.info({ runId, outcome: result.outcome, grantedUsd: result.grantedUsd }, "coding run overrun top-up");
      }
      return result;
    } catch (err) {
      const retryable = isSerializationConflict(err) || isTransactionUnavailable(err);
      if (!retryable || attempt >= PERSIST_ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40 * (attempt + 1)));
    }
  }
}
