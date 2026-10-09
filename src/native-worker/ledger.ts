/**
 * The native sandbox gateway's durable state (native sandbox phase 3): one
 * session per sandbox-mode run, and one call row per worker callId. Modelled on
 * the coding proxy's PrismaProxyLedger — a model call reserves against the
 * session budget under a row lock on the session before the provider is
 * called, and is settled at its actual cost after — so any control-plane
 * replica can serve any call, and a restart loses nothing.
 */

import type { Prisma, PrismaClient } from "#prisma";

export type GatewayLedgerDb = Pick<
  PrismaClient,
  "$transaction" | "$queryRaw" | "nativeGatewaySession" | "nativeGatewayCall"
>;

export interface GatewaySessionRecord {
  id: string;
  runId: string;
  status: "active" | "finished" | "cancelled";
  deadlineAt: Date;
  budgetUsd: number;
  snapshot: unknown;
  networkReadyAt: Date | null;
}

export interface CreateGatewaySessionInput {
  runId: string;
  capabilityHash: string;
  deadlineAt: Date;
  budgetUsd: number;
  snapshot: Prisma.InputJsonValue;
  /** Set at creation when the launcher's isolation exists before the worker does (Docker). */
  networkReadyAt?: Date | null;
}

export type ReserveOutcome =
  | { outcome: "reserved" }
  | { outcome: "duplicate" }
  | { outcome: "inactive"; reason: "ended" | "expired" }
  | { outcome: "budget_exhausted" };

export interface SettledUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface GatewayTotals {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Settled cost plus every live (reserved or uncertain) reservation: what the budget is checked against. */
  heldUsd: number;
}

export type ClaimOutcome = { outcome: "claimed" } | { outcome: "in_flight" } | { outcome: "done"; result: unknown };

export interface DelegationState {
  status: "pending" | "waiting_budget" | "completed";
  childRunId: string | null;
  childAgentId: string | null;
  /** When the delegation was first called: its wait bounds count from here. */
  createdAt: Date;
}

const LEDGER_TX = { maxWait: 5_000, timeout: 20_000 } as const;

function toSession(row: {
  id: string;
  runId: string;
  status: GatewaySessionRecord["status"];
  deadlineAt: Date;
  budgetUsd: Prisma.Decimal;
  snapshot: Prisma.JsonValue;
  networkReadyAt: Date | null;
}): GatewaySessionRecord {
  return { ...row, budgetUsd: Number(row.budgetUsd) };
}

export class PrismaGatewayLedger {
  constructor(private readonly db: GatewayLedgerDb) {}

  async createSession(input: CreateGatewaySessionInput): Promise<GatewaySessionRecord> {
    return toSession(await this.db.nativeGatewaySession.create({ data: input }));
  }

  /** The session a capability belongs to, whatever its status; the caller decides what each status allows. */
  async findSessionByCapabilityHash(capabilityHash: string): Promise<GatewaySessionRecord | null> {
    const row = await this.db.nativeGatewaySession.findUnique({ where: { capabilityHash } });
    return row ? toSession(row) : null;
  }

  /** Records that the worker's network isolation was proven: the gateway serves it from now on. */
  async markNetworkReady(sessionId: string, at: Date = new Date()): Promise<void> {
    await this.db.nativeGatewaySession.updateMany({
      where: { id: sessionId, networkReadyAt: null },
      data: { networkReadyAt: at },
    });
  }

  /** markNetworkReady by the session's run (a launcher knows the run, not the session). */
  async markNetworkReadyForRun(runId: string, at: Date = new Date()): Promise<void> {
    await this.db.nativeGatewaySession.updateMany({
      where: { runId, networkReadyAt: null },
      data: { networkReadyAt: at },
    });
  }

  async endSession(sessionId: string, status: "finished" | "cancelled"): Promise<void> {
    await this.db.nativeGatewaySession.updateMany({ where: { id: sessionId, status: "active" }, data: { status } });
  }

  /** Reserves `reservationUsd` for a model call, or says why not. Serialized per session. */
  async reserve(input: {
    sessionId: string;
    callId: string;
    reservationUsd: number;
    now: Date;
  }): Promise<ReserveOutcome> {
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string; deadlineAt: Date; budgetUsd: Prisma.Decimal }[]>`
        SELECT "status", "deadlineAt", "budgetUsd" FROM "NativeGatewaySession" WHERE "id" = ${input.sessionId} FOR UPDATE`;
      const session = locked[0];
      if (!session || session.status !== "active") return { outcome: "inactive", reason: "ended" } as const;
      if (input.now.getTime() >= session.deadlineAt.getTime())
        return { outcome: "inactive", reason: "expired" } as const;

      const existing = await tx.nativeGatewayCall.findUnique({
        where: { sessionId_callId: { sessionId: input.sessionId, callId: input.callId } },
      });
      if (existing) return { outcome: "duplicate" } as const;

      const held = await heldUsd(tx, input.sessionId);
      if (held + input.reservationUsd >= Number(session.budgetUsd)) {
        await tx.nativeGatewaySession.updateMany({
          where: { id: input.sessionId, budgetExhaustedAt: null },
          data: { budgetExhaustedAt: input.now },
        });
        return { outcome: "budget_exhausted" } as const;
      }
      await tx.nativeGatewayCall.create({
        data: {
          sessionId: input.sessionId,
          callId: input.callId,
          method: "llm.stream",
          status: "reserved",
          reservationUsd: input.reservationUsd,
        },
      });
      return { outcome: "reserved" } as const;
    }, LEDGER_TX);
  }

  /** Settles a reserved (or uncertain) model call at what it actually cost. */
  async complete(sessionId: string, callId: string, usage: SettledUsage): Promise<void> {
    await this.db.nativeGatewayCall.updateMany({
      where: { sessionId, callId, status: { in: ["reserved", "uncertain"] } },
      data: {
        status: "completed",
        actualCostUsd: usage.costUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        completedAt: new Date(),
      },
    });
  }

  /** Frees a reservation the provider never billed (it refused the request). */
  async release(sessionId: string, callId: string): Promise<void> {
    await this.db.nativeGatewayCall.updateMany({
      where: { sessionId, callId, status: "reserved" },
      data: { status: "released", completedAt: new Date() },
    });
  }

  /** The outcome is unknown (the connection broke mid-call): the reservation stays held. */
  async markUncertain(sessionId: string, callId: string): Promise<void> {
    await this.db.nativeGatewayCall.updateMany({
      where: { sessionId, callId, status: "reserved" },
      data: { status: "uncertain" },
    });
  }

  async totals(sessionId: string): Promise<GatewayTotals> {
    const completed = await this.db.nativeGatewayCall.aggregate({
      where: { sessionId, status: "completed", method: "llm.stream" },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheWriteTokens: true,
        actualCostUsd: true,
      },
    });
    return {
      tokensIn: completed._sum.inputTokens ?? 0,
      tokensOut: completed._sum.outputTokens ?? 0,
      cachedInputTokens: completed._sum.cachedInputTokens ?? 0,
      cacheWriteTokens: completed._sum.cacheWriteTokens ?? 0,
      costUsd: Number(completed._sum.actualCostUsd ?? 0),
      heldUsd: await heldUsd(this.db, sessionId),
    };
  }

  /** Claims a one-shot call by callId: the first claimant runs it, a repeat waits or replays. */
  async claim(sessionId: string, callId: string, method: string): Promise<ClaimOutcome> {
    const created = await this.db.nativeGatewayCall.createMany({
      data: [{ sessionId, callId, method, status: "pending" }],
      skipDuplicates: true,
    });
    if (created.count === 1) return { outcome: "claimed" };
    const row = await this.db.nativeGatewayCall.findUnique({ where: { sessionId_callId: { sessionId, callId } } });
    if (row?.status === "completed") return { outcome: "done", result: row.result };
    return { outcome: "in_flight" };
  }

  async recordResult(sessionId: string, callId: string, result: Prisma.InputJsonValue): Promise<void> {
    await this.db.nativeGatewayCall.updateMany({
      where: { sessionId, callId },
      data: { status: "completed", result, completedAt: new Date() },
    });
  }

  /** A delegation's durable progress: its sub-agent, whether it waits for budget, and its child run once started. */
  async setDelegation(
    sessionId: string,
    callId: string,
    state: { status: "pending" | "waiting_budget"; childAgentId: string; childRunId?: string },
  ): Promise<void> {
    await this.db.nativeGatewayCall.updateMany({
      where: { sessionId, callId, status: { in: ["pending", "waiting_budget"] } },
      data: {
        status: state.status,
        childAgentId: state.childAgentId,
        ...(state.childRunId ? { childRunId: state.childRunId } : {}),
      },
    });
  }

  async delegation(sessionId: string, callId: string): Promise<DelegationState | null> {
    const row = await this.db.nativeGatewayCall.findUnique({ where: { sessionId_callId: { sessionId, callId } } });
    if (!row) return null;
    const status =
      row.status === "waiting_budget" ? "waiting_budget" : row.status === "completed" ? "completed" : "pending";
    return { status, childRunId: row.childRunId, childAgentId: row.childAgentId, createdAt: row.createdAt };
  }

  /** The sub-agents other delegations of this run are waiting for budget to start. */
  async waitingChildAgentIds(sessionId: string, exceptCallId: string): Promise<string[]> {
    const rows = await this.db.nativeGatewayCall.findMany({
      where: { sessionId, status: "waiting_budget", callId: { not: exceptCallId }, childAgentId: { not: null } },
      select: { childAgentId: true },
    });
    return rows.map((row) => row.childAgentId as string);
  }

  /** Delegations of this session whose child run is started and not yet reported. */
  async openDelegationChildren(sessionId: string): Promise<string[]> {
    const rows = await this.db.nativeGatewayCall.findMany({
      where: { sessionId, status: "pending", childRunId: { not: null } },
      select: { childRunId: true },
    });
    return rows.map((row) => row.childRunId as string);
  }
}

async function heldUsd(db: Pick<PrismaClient, "$queryRaw">, sessionId: string): Promise<number> {
  const rows = await db.$queryRaw<{ held: unknown }[]>`
    SELECT COALESCE(SUM(
      CASE
        WHEN "status" = 'completed' THEN COALESCE("actualCostUsd", 0)
        WHEN "status" IN ('reserved', 'uncertain') THEN COALESCE("reservationUsd", 0)
        ELSE 0
      END
    ), 0) AS "held"
    FROM "NativeGatewayCall" WHERE "sessionId" = ${sessionId} AND "method" = 'llm.stream'`;
  return Number(rows[0]?.held ?? 0);
}
