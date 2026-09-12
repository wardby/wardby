import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  CreateProxySessionInput,
  PricingSnapshot,
  ProxyLedger,
  ProxyRequest,
  ProxyRequestStatus,
  ProxySession,
  ProxySessionStatus,
  ProxyUsage,
  ReserveProxyRequestInput,
  ReserveProxyRequestResult,
} from "./types.js";

export type PrismaProxyLedgerDb = Pick<PrismaClient, "$transaction" | "$queryRaw" | "$executeRaw">;
type PrismaProxyLedgerTx = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

interface SessionRow {
  id: string;
  runId: string;
  capabilityHash: string;
  credentialRef: string;
  protocol: string;
  allowedModels: unknown;
  deadlineAt: Date;
  budgetUsd: unknown;
  status: string;
}

interface RequestRow {
  id: string;
  sessionId: string;
  requestKey: string;
  requestFingerprint: string;
  model: string;
  status: string;
  reservationUsd: unknown;
  actualCostUsd: unknown;
  pricingVersion: string;
  pricingSnapshot: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  upstreamStatus: number | null;
}

function sessionFromRow(row: SessionRow): ProxySession {
  if (!Array.isArray(row.allowedModels) || !row.allowedModels.every((model) => typeof model === "string")) {
    throw new Error("invalid_proxy_session_models");
  }
  if (row.protocol !== "openai-responses" && row.protocol !== "anthropic-messages") {
    throw new Error("invalid_proxy_session_protocol");
  }
  return {
    id: row.id,
    runId: row.runId,
    capabilityHash: row.capabilityHash,
    credentialRef: row.credentialRef,
    protocol: row.protocol,
    allowedModels: row.allowedModels,
    deadlineAt: row.deadlineAt,
    budgetUsd: Number(row.budgetUsd),
    status: row.status as ProxySessionStatus,
  };
}

function requestFromRow(row: RequestRow): ProxyRequest {
  const pricing = row.pricingSnapshot as Omit<PricingSnapshot, "version">;
  const hasUsage = row.inputTokens !== null && row.outputTokens !== null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    requestKey: row.requestKey,
    requestFingerprint: row.requestFingerprint,
    model: row.model,
    status: row.status as ProxyRequestStatus,
    reservationUsd: Number(row.reservationUsd),
    actualCostUsd: row.actualCostUsd === null ? undefined : Number(row.actualCostUsd),
    pricing: { ...pricing, version: row.pricingVersion },
    usage: hasUsage
      ? {
          inputTokens: row.inputTokens!,
          outputTokens: row.outputTokens!,
          cachedInputTokens: row.cachedInputTokens ?? 0,
          cacheWriteTokens: row.cacheWriteTokens ?? 0,
          reasoningTokens: row.reasoningTokens ?? 0,
        }
      : undefined,
    upstreamStatus: row.upstreamStatus ?? undefined,
  };
}

async function requestById(db: PrismaProxyLedgerTx | PrismaProxyLedgerDb, id: string): Promise<ProxyRequest | null> {
  const rows = await db.$queryRaw<RequestRow[]>`
    SELECT "id", "sessionId", "requestKey", "requestFingerprint", "model", "status",
           "reservationUsd", "actualCostUsd", "pricingVersion", "pricingSnapshot",
           "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
           "reasoningTokens", "upstreamStatus"
    FROM "CodingProxyRequest" WHERE "id" = ${id}
  `;
  return rows[0] ? requestFromRow(rows[0]) : null;
}

export class PrismaProxyLedger implements ProxyLedger {
  constructor(private readonly db: PrismaProxyLedgerDb) {}

  async createSession(input: CreateProxySessionInput): Promise<void> {
    const models = JSON.stringify(input.allowedModels);
    await this.db.$executeRaw`
      INSERT INTO "CodingProxySession"
        ("id", "runId", "capabilityHash", "credentialRef", "protocol", "allowedModels", "deadlineAt",
         "budgetUsd", "status", "createdAt", "updatedAt")
      VALUES
        (${input.id}, ${input.runId}, ${input.capabilityHash}, ${input.credentialRef}, ${input.protocol}, ${models}::jsonb,
         ${input.deadlineAt}, ${input.budgetUsd}, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
  }

  async findSessionByCapabilityHash(capabilityHash: string): Promise<ProxySession | null> {
    const rows = await this.db.$queryRaw<SessionRow[]>`
      SELECT "id", "runId", "capabilityHash", "credentialRef", "protocol", "allowedModels", "deadlineAt", "budgetUsd", "status"
      FROM "CodingProxySession" WHERE "capabilityHash" = ${capabilityHash}
    `;
    return rows[0] ? sessionFromRow(rows[0]) : null;
  }

  async reserve(input: ReserveProxyRequestInput): Promise<ReserveProxyRequestResult> {
    return this.db.$transaction(async (tx) => {
      const sessions = await tx.$queryRaw<SessionRow[]>`
          SELECT "id", "runId", "capabilityHash", "credentialRef", "protocol", "allowedModels", "deadlineAt", "budgetUsd", "status"
          FROM "CodingProxySession" WHERE "id" = ${input.sessionId} FOR UPDATE
        `;
      const row = sessions[0];
      if (!row || row.status !== "active") return { outcome: "inactive", reason: "cancelled" } as const;
      if (input.now.getTime() >= row.deadlineAt.getTime()) return { outcome: "inactive", reason: "expired" } as const;

      const duplicate = await tx.$queryRaw<RequestRow[]>`
          SELECT "id", "sessionId", "requestKey", "requestFingerprint", "model", "status",
                 "reservationUsd", "actualCostUsd", "pricingVersion", "pricingSnapshot",
                 "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
                 "reasoningTokens", "upstreamStatus"
          FROM "CodingProxyRequest"
          WHERE "sessionId" = ${input.sessionId} AND "requestKey" = ${input.requestKey}
        `;
      if (duplicate[0]) return { outcome: "duplicate", request: requestFromRow(duplicate[0]) } as const;

      const totals = await tx.$queryRaw<{ held: unknown }[]>`
          SELECT COALESCE(SUM(
            CASE
              WHEN "status" = 'completed' THEN "actualCostUsd"
              WHEN "status" IN ('reserved', 'uncertain') THEN "reservationUsd"
              ELSE 0
            END
          ), 0) AS "held"
          FROM "CodingProxyRequest" WHERE "sessionId" = ${input.sessionId}
        `;
      if (Number(totals[0]?.held ?? 0) + input.reservationUsd >= Number(row.budgetUsd)) {
        return { outcome: "budget_exhausted" } as const;
      }
      const pricing = JSON.stringify({
        encoding: input.pricing.encoding,
        inputPerMTok: input.pricing.inputPerMTok,
        outputPerMTok: input.pricing.outputPerMTok,
        cachedInputPerMTok: input.pricing.cachedInputPerMTok,
        cacheWritePerMTok: input.pricing.cacheWritePerMTok,
      });
      await tx.$executeRaw`
          INSERT INTO "CodingProxyRequest"
            ("id", "sessionId", "requestKey", "requestFingerprint", "model", "status",
             "reservationUsd", "pricingVersion", "pricingSnapshot", "createdAt", "updatedAt")
          VALUES
            (${input.id}, ${input.sessionId}, ${input.requestKey}, ${input.requestFingerprint}, ${input.model},
             'reserved', ${input.reservationUsd}, ${input.pricing.version}, ${pricing}::jsonb,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
      const request = await requestById(tx, input.id);
      if (!request) throw new Error("proxy_reservation_not_persisted");
      return { outcome: "reserved", request } as const;
    });
  }

  async complete(
    requestId: string,
    usage: ProxyUsage,
    actualCostUsd: number,
    upstreamStatus: number,
  ): Promise<ProxyRequest> {
    return this.db.$transaction(async (tx) => {
      const initial = await requestById(tx, requestId);
      if (!initial) throw new Error("unknown_proxy_request");
      await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "CodingProxySession" WHERE "id" = ${initial.sessionId} FOR UPDATE
        `;
      const locked = await tx.$queryRaw<RequestRow[]>`
          SELECT "id", "sessionId", "requestKey", "requestFingerprint", "model", "status",
                 "reservationUsd", "actualCostUsd", "pricingVersion", "pricingSnapshot",
                 "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
                 "reasoningTokens", "upstreamStatus"
          FROM "CodingProxyRequest" WHERE "id" = ${requestId} FOR UPDATE
        `;
      const prior = locked[0] ? requestFromRow(locked[0]) : null;
      if (!prior) throw new Error("unknown_proxy_request");
      if (prior.status === "released") throw new Error("proxy_request_released");
      if (prior.status === "completed") {
        if (
          Math.abs((prior.actualCostUsd ?? -1) - actualCostUsd) > 1e-12 ||
          JSON.stringify(prior.usage) !== JSON.stringify(usage)
        ) {
          throw new Error("proxy_completion_conflict");
        }
        return prior;
      }
      await tx.$executeRaw`
          UPDATE "CodingProxyRequest"
          SET "status" = 'completed', "actualCostUsd" = ${actualCostUsd},
              "inputTokens" = ${usage.inputTokens}, "outputTokens" = ${usage.outputTokens},
              "cachedInputTokens" = ${usage.cachedInputTokens}, "cacheWriteTokens" = ${usage.cacheWriteTokens},
              "reasoningTokens" = ${usage.reasoningTokens}, "upstreamStatus" = ${upstreamStatus},
              "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${requestId} AND "status" IN ('reserved', 'uncertain')
        `;
      await tx.$executeRaw`
          UPDATE "Run" AS r
          SET "tokensIn" = totals."tokensIn", "tokensOut" = totals."tokensOut", "costUsd" = totals."costUsd"
          FROM (
            SELECT s."runId", COALESCE(SUM(q."inputTokens"), 0)::integer AS "tokensIn",
                   COALESCE(SUM(q."outputTokens"), 0)::integer AS "tokensOut",
                   COALESCE(SUM(q."actualCostUsd"), 0) AS "costUsd"
            FROM "CodingProxySession" s
            JOIN "CodingProxyRequest" q ON q."sessionId" = s."id" AND q."status" = 'completed'
            WHERE s."id" = ${prior.sessionId}
            GROUP BY s."runId"
          ) AS totals
          WHERE r."id" = totals."runId"
        `;
      const request = await requestById(tx, requestId);
      if (!request) throw new Error("proxy_completion_not_persisted");
      return request;
    });
  }

  async release(requestId: string, upstreamStatus: number): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "CodingProxyRequest"
      SET "status" = 'released', "upstreamStatus" = ${upstreamStatus}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${requestId} AND "status" = 'reserved'
    `;
  }

  async markUncertain(requestId: string, upstreamStatus?: number): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "CodingProxyRequest"
      SET "status" = 'uncertain', "upstreamStatus" = ${upstreamStatus ?? null}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${requestId} AND "status" = 'reserved'
    `;
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "CodingProxySession" SET "status" = 'cancelled', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${sessionId} AND "status" = 'active'
    `;
  }

  getRequest(requestId: string): Promise<ProxyRequest | null> {
    return requestById(this.db, requestId);
  }
}
