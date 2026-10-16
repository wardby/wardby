import type { Prisma, PrismaClient } from "#prisma";
import { logger } from "../../core/logger.js";
import { normalizeProxyModelTerms } from "./types.js";
import type {
  CreateProxySessionInput,
  PreviousReply,
  PricingSnapshot,
  ProxyLedger,
  ProxyRefusalRecord,
  ProxyRequest,
  ProxyRequestStatus,
  ProxySession,
  ProxySessionStatus,
  ProxyUsage,
  ReserveProxyRequestInput,
  ReserveProxyRequestResult,
} from "./types.js";

const log = logger.child({ module: "coding-proxy-ledger" });

export type PrismaProxyLedgerDb = Pick<PrismaClient, "$transaction" | "$queryRaw" | "$executeRaw">;
type PrismaProxyLedgerTx = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/** How long a ledger transaction waits for a pool connection (Prisma's
 *  default is 2 s). A model request fails outright when this runs out, so it
 *  gets more room than the default; its pool is also kept apart from the
 *  package registry's (coding-proxy/main.ts). */
export const LEDGER_TRANSACTION_MAX_WAIT_MS = 5_000;

/** How long a ledger transaction may run once started (Prisma's default is
 *  5 s). Each is a handful of small queries, but a proxy busy with package
 *  installs (the registry's dependency walk parses large npm documents on the
 *  same event loop) can stall between them; a live lockfile install expired
 *  one ("A commit cannot be executed on an expired transaction") and failed
 *  the model request. The row lock it holds is per session, so a longer
 *  window only delays that run's own next request. */
export const LEDGER_TRANSACTION_TIMEOUT_MS = 20_000;

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
  registryTokenHash: string | null;
  budgetExhaustedAt?: Date | null;
  upstreamFailure?: string | null;
  /** Selected by findSessionByCapabilityHash only. */
  pricingVersion?: string | null;
  catalogEntry?: unknown;
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
  costEstimated: boolean | null;
  requestBytes: number | null;
  ceilingUsd: unknown;
  reservationBasis: string | null;
  conversationKey: string | null;
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
    registryTokenHash: row.registryTokenHash,
    budgetExhaustedAt: row.budgetExhaustedAt ?? null,
    upstreamFailure: row.upstreamFailure ?? null,
    terms: sessionTerms(row),
  };
}

/**
 * The session's stored model terms. Null only when both columns are null (a session from before
 * the catalog, which prices from the shipped fallback); terms that are partly present or cannot be
 * read throw, so the session is refused rather than billed at fallback rates.
 */
function sessionTerms(row: SessionRow): ProxySession["terms"] {
  const version = row.pricingVersion ?? null;
  const stored = row.catalogEntry ?? null;
  if (version === null && stored === null) return null;
  return normalizeProxyModelTerms({ version, entry: stored });
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
    costEstimated: row.costEstimated === true,
    ...(row.requestBytes !== null ? { requestBytes: row.requestBytes } : {}),
    ...(row.ceilingUsd !== null && row.ceilingUsd !== undefined ? { ceilingUsd: Number(row.ceilingUsd) } : {}),
    ...(row.reservationBasis === "cached" || row.reservationBasis === "full"
      ? { reservationBasis: row.reservationBasis }
      : {}),
    ...(row.conversationKey !== null ? { conversationKey: row.conversationKey } : {}),
  };
}

async function requestById(db: PrismaProxyLedgerTx | PrismaProxyLedgerDb, id: string): Promise<ProxyRequest | null> {
  const rows = await db.$queryRaw<RequestRow[]>`
    SELECT "id", "sessionId", "requestKey", "requestFingerprint", "model", "status",
           "reservationUsd", "actualCostUsd", "pricingVersion", "pricingSnapshot",
           "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
           "reasoningTokens", "upstreamStatus", "costEstimated",
           "requestBytes", "ceilingUsd", "reservationBasis", "conversationKey"
    FROM "CodingProxyRequest" WHERE "id" = ${id}
  `;
  return rows[0] ? requestFromRow(rows[0]) : null;
}

export class PrismaProxyLedger implements ProxyLedger {
  constructor(private readonly db: PrismaProxyLedgerDb) {}

  private transaction<T>(fn: (tx: PrismaProxyLedgerTx) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, {
      maxWait: LEDGER_TRANSACTION_MAX_WAIT_MS,
      timeout: LEDGER_TRANSACTION_TIMEOUT_MS,
    });
  }

  async createSession(input: CreateProxySessionInput): Promise<void> {
    const models = JSON.stringify(input.allowedModels);
    const terms = input.terms ? normalizeProxyModelTerms(input.terms) : undefined;
    await this.db.$executeRaw`
      INSERT INTO "CodingProxySession"
        ("id", "runId", "capabilityHash", "credentialRef", "protocol", "allowedModels", "deadlineAt",
         "budgetUsd", "status", "registryTokenHash", "pricingVersion", "catalogEntry", "createdAt", "updatedAt")
      VALUES
        (${input.id}, ${input.runId}, ${input.capabilityHash}, ${input.credentialRef}, ${input.protocol}, ${models}::jsonb,
         ${input.deadlineAt}, ${input.budgetUsd}, 'active', ${input.registryTokenHash},
         ${terms?.version ?? null}, ${terms ? JSON.stringify(terms.entry) : null}::jsonb,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
  }

  async findSessionByCapabilityHash(capabilityHash: string): Promise<ProxySession | null> {
    const rows = await this.db.$queryRaw<SessionRow[]>`
      SELECT "id", "runId", "capabilityHash", "credentialRef", "protocol", "allowedModels", "deadlineAt", "budgetUsd", "status", "registryTokenHash",
             "budgetExhaustedAt", "upstreamFailure", "pricingVersion", "catalogEntry"
      FROM "CodingProxySession" WHERE "capabilityHash" = ${capabilityHash}
    `;
    return rows[0] ? sessionFromRow(rows[0]) : null;
  }

  async reserve(input: ReserveProxyRequestInput): Promise<ReserveProxyRequestResult> {
    return this.transaction(async (tx) => {
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
                 "reasoningTokens", "upstreamStatus", "costEstimated",
                 "requestBytes", "ceilingUsd", "reservationBasis", "conversationKey"
          FROM "CodingProxyRequest"
          WHERE "sessionId" = ${input.sessionId} AND "requestKey" = ${input.requestKey}
        `;
      if (duplicate[0]) return { outcome: "duplicate", request: requestFromRow(duplicate[0]) } as const;

      const totals = await tx.$queryRaw<
        { spent: unknown; heldReserved: unknown; heldUncertain: unknown; done: unknown }[]
      >`
          SELECT
            COALESCE(SUM(CASE
              WHEN "status" = 'completed' THEN "actualCostUsd"
              WHEN "status" = 'uncertain' AND "costEstimated" THEN "actualCostUsd"
              ELSE 0
            END), 0) AS "spent",
            COALESCE(SUM(CASE WHEN "status" = 'reserved' THEN "reservationUsd" ELSE 0 END), 0) AS "heldReserved",
            COALESCE(SUM(CASE
              WHEN "status" = 'uncertain' AND NOT "costEstimated" THEN "reservationUsd"
              ELSE 0
            END), 0) AS "heldUncertain",
            COUNT(*) FILTER (
              WHERE "status" = 'completed' OR ("status" = 'uncertain' AND "costEstimated")
            ) AS "done"
          FROM "CodingProxyRequest" WHERE "sessionId" = ${input.sessionId}
        `;
      const spentUsd = Number(totals[0]?.spent ?? 0);
      const heldReservedUsd = Number(totals[0]?.heldReserved ?? 0);
      const heldUncertainUsd = Number(totals[0]?.heldUncertain ?? 0);
      if (spentUsd + heldReservedUsd + heldUncertainUsd + input.reservationUsd >= Number(row.budgetUsd)) {
        const details = {
          budgetUsd: Number(row.budgetUsd),
          spentUsd,
          heldReservedUsd,
          heldUncertainUsd,
          refusedHoldUsd: input.reservationUsd,
          ...(input.reservationBasis ? { refusedHoldBasis: input.reservationBasis } : {}),
          ...(input.ceilingUsd !== undefined ? { refusedHoldCeilingUsd: input.ceilingUsd } : {}),
          model: input.model,
          turn: Number(totals[0]?.done ?? 0) + 1,
        };
        // The numbers of the session's first refusal only; the control plane copies them into the
        // run's budget event (this role has no access to that table).
        const detailsJson = JSON.stringify({ source: "proxy", ...details });
        await tx.$executeRaw`
            UPDATE "CodingProxySession"
            SET "budgetExhaustedAt" = ${input.now}, "budgetRefusal" = ${detailsJson}::jsonb
            WHERE "id" = ${input.sessionId} AND "budgetExhaustedAt" IS NULL
          `;
        return { outcome: "budget_exhausted", details } as const;
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
             "reservationUsd", "pricingVersion", "pricingSnapshot", "requestBytes", "ceilingUsd",
             "reservationBasis", "conversationKey", "createdAt", "updatedAt")
          VALUES
            (${input.id}, ${input.sessionId}, ${input.requestKey}, ${input.requestFingerprint}, ${input.model},
             'reserved', ${input.reservationUsd}, ${input.pricing.version}, ${pricing}::jsonb,
             ${input.requestBytes ?? null}, ${input.ceilingUsd ?? null}, ${input.reservationBasis ?? null},
             ${input.conversationKey ?? null}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
    return this.transaction(async (tx) => {
      const initial = await requestById(tx, requestId);
      if (!initial) throw new Error("unknown_proxy_request");
      await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "CodingProxySession" WHERE "id" = ${initial.sessionId} FOR UPDATE
        `;
      const locked = await tx.$queryRaw<RequestRow[]>`
          SELECT "id", "sessionId", "requestKey", "requestFingerprint", "model", "status",
                 "reservationUsd", "actualCostUsd", "pricingVersion", "pricingSnapshot",
                 "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
                 "reasoningTokens", "upstreamStatus", "costEstimated",
                 "requestBytes", "ceilingUsd", "reservationBasis", "conversationKey"
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
              "costEstimated" = false,
              "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${requestId} AND "status" IN ('reserved', 'uncertain')
        `;
      await this.recomputeRunTotals(tx, prior.sessionId, prior.model);
      const request = await requestById(tx, requestId);
      if (!request) throw new Error("proxy_completion_not_persisted");
      return request;
    });
  }

  /**
   * Recomputes the run's totals (Run) and this model's usage (RunModelUsage) from its settled
   * requests: completed ones and uncertain ones settled at an estimate. Set, never incremented.
   */
  private async recomputeRunTotals(tx: PrismaProxyLedgerTx, sessionId: string, model: string): Promise<void> {
    const [updatedRun] = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "Run" AS r
        SET "tokensIn" = totals."tokensIn", "tokensOut" = totals."tokensOut", "costUsd" = totals."costUsd",
            "turns" = totals."turns"
        FROM (
          SELECT s."runId", COALESCE(SUM(q."inputTokens"), 0)::integer AS "tokensIn",
                 COALESCE(SUM(q."outputTokens"), 0)::integer AS "tokensOut",
                 COALESCE(SUM(q."actualCostUsd"), 0) AS "costUsd",
                 COUNT(*)::integer AS "turns"
          FROM "CodingProxySession" s
          JOIN "CodingProxyRequest" q ON q."sessionId" = s."id"
            AND (q."status" = 'completed' OR (q."status" = 'uncertain' AND q."costEstimated"))
          WHERE s."id" = ${sessionId}
          GROUP BY s."runId"
        ) AS totals
        WHERE r."id" = totals."runId"
        RETURNING r."id"
      `;
    // Per-model usage (RunModelUsage), recomputed for this request's model and set, never incremented.
    // Best effort inside a savepoint: Run totals and the ledger are the budget truth, so a failed
    // write here (e.g. a role without the RunModelUsage grant) must never fail the completion.
    await tx.$executeRaw`SAVEPOINT run_model_usage`;
    try {
      await tx.$executeRaw`
          INSERT INTO "RunModelUsage"
            ("runId", "model", "freshInputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "costUsd")
          SELECT s."runId", q."model",
                 COALESCE(SUM(COALESCE(q."inputTokens", 0) - COALESCE(q."cachedInputTokens", 0)), 0)::integer,
                 COALESCE(SUM(q."cachedInputTokens"), 0)::integer,
                 COALESCE(SUM(q."cacheWriteTokens"), 0)::integer,
                 COALESCE(SUM(q."outputTokens"), 0)::integer,
                 COALESCE(SUM(q."actualCostUsd"), 0)
          FROM "CodingProxySession" s
          JOIN "CodingProxyRequest" q ON q."sessionId" = s."id"
            AND (q."status" = 'completed' OR (q."status" = 'uncertain' AND q."costEstimated"))
          WHERE s."id" = ${sessionId} AND q."model" = ${model}
          GROUP BY s."runId", q."model"
          ON CONFLICT ("runId", "model") DO UPDATE SET
            "freshInputTokens" = EXCLUDED."freshInputTokens",
            "cachedInputTokens" = EXCLUDED."cachedInputTokens",
            "cacheWriteTokens" = EXCLUDED."cacheWriteTokens",
            "outputTokens" = EXCLUDED."outputTokens",
            "costUsd" = EXCLUDED."costUsd"
        `;
      await tx.$executeRaw`RELEASE SAVEPOINT run_model_usage`;
    } catch (err) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT run_model_usage`;
      log.warn({ err, runId: updatedRun?.id, sessionId, model }, "could not record the run's model usage");
    }
  }

  async release(requestId: string, upstreamStatus: number): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "CodingProxyRequest"
      SET "status" = 'released', "upstreamStatus" = ${upstreamStatus}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${requestId} AND "status" = 'reserved'
    `;
  }

  async markUncertain(
    requestId: string,
    upstreamStatus?: number,
    estimate?: { usage: ProxyUsage; costUsd: number },
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const initial = await requestById(tx, requestId);
      if (!initial) return;
      await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "CodingProxySession" WHERE "id" = ${initial.sessionId} FOR UPDATE
        `;
      const updated = await tx.$executeRaw`
          UPDATE "CodingProxyRequest"
          SET "status" = 'uncertain', "upstreamStatus" = ${upstreamStatus ?? null},
              "actualCostUsd" = ${estimate?.costUsd ?? null},
              "inputTokens" = ${estimate?.usage.inputTokens ?? null}, "outputTokens" = ${estimate?.usage.outputTokens ?? null},
              "cachedInputTokens" = ${estimate?.usage.cachedInputTokens ?? null},
              "cacheWriteTokens" = ${estimate?.usage.cacheWriteTokens ?? null},
              "reasoningTokens" = ${estimate ? 0 : null},
              "costEstimated" = ${estimate !== undefined}, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${requestId} AND "status" = 'reserved'
        `;
      if (estimate && updated > 0) await this.recomputeRunTotals(tx, initial.sessionId, initial.model);
    });
  }

  async settlementHints(
    sessionId: string,
    model: string,
  ): Promise<{ previous?: ProxyUsage; medianOutputTokens?: number }> {
    const latest = await this.db.$queryRaw<
      Pick<RequestRow, "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens">[]
    >`
      SELECT "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"
      FROM "CodingProxyRequest"
      WHERE "sessionId" = ${sessionId} AND "model" = ${model} AND "status" = 'completed' AND NOT "costEstimated"
      ORDER BY "completedAt" DESC NULLS LAST LIMIT 1
    `;
    const median = await this.db.$queryRaw<{ median: number | null }[]>`
      SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY "outputTokens") AS "median"
      FROM "CodingProxyRequest"
      WHERE "sessionId" = ${sessionId} AND "status" = 'completed' AND "outputTokens" IS NOT NULL
    `;
    const row = latest[0];
    const previous: ProxyUsage | undefined =
      row && row.inputTokens !== null && row.outputTokens !== null
        ? {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokens: row.cachedInputTokens ?? 0,
            cacheWriteTokens: row.cacheWriteTokens ?? 0,
            reasoningTokens: row.reasoningTokens ?? 0,
          }
        : undefined;
    const medianOutputTokens = median[0]?.median ?? null;
    return {
      ...(previous ? { previous } : {}),
      ...(medianOutputTokens !== null ? { medianOutputTokens: Number(medianOutputTokens) } : {}),
    };
  }

  async previousReply(sessionId: string, conversationKey: string): Promise<PreviousReply | null> {
    const rows = await this.db.$queryRaw<
      (Pick<
        RequestRow,
        | "model"
        | "status"
        | "costEstimated"
        | "inputTokens"
        | "outputTokens"
        | "cachedInputTokens"
        | "cacheWriteTokens"
        | "reasoningTokens"
        | "requestBytes"
      > & { completedAt: Date | null })[]
    >`
      SELECT "model", "status", "costEstimated", "inputTokens", "outputTokens", "cachedInputTokens",
             "cacheWriteTokens", "reasoningTokens", "requestBytes", "completedAt"
      FROM "CodingProxyRequest"
      WHERE "sessionId" = ${sessionId} AND "conversationKey" = ${conversationKey}
        AND "status" IN ('completed', 'uncertain')
      ORDER BY "createdAt" DESC LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const usage =
      row.inputTokens !== null && row.outputTokens !== null
        ? {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokens: row.cachedInputTokens ?? 0,
            cacheWriteTokens: row.cacheWriteTokens ?? 0,
            reasoningTokens: row.reasoningTokens ?? 0,
          }
        : undefined;
    return {
      model: row.model,
      status: row.status as "completed" | "uncertain",
      costEstimated: row.costEstimated === true,
      ...(usage ? { usage } : {}),
      requestBytes: row.requestBytes,
      completedAt: row.completedAt,
    };
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "CodingProxySession" SET "status" = 'cancelled', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${sessionId} AND "status" = 'active'
    `;
  }

  async budgetExhausted(sessionId: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CodingProxySession" WHERE "id" = ${sessionId} AND "budgetExhaustedAt" IS NOT NULL
    `;
    return rows.length > 0;
  }

  async budgetRefusal(sessionId: string): Promise<ProxyRefusalRecord | null> {
    const rows = await this.db.$queryRaw<{ budgetRefusal: unknown }[]>`
      SELECT "budgetRefusal" FROM "CodingProxySession" WHERE "id" = ${sessionId}
    `;
    const value = rows[0]?.budgetRefusal;
    return value && typeof value === "object" ? (value as ProxyRefusalRecord) : null;
  }

  async recordUpstreamFailure(sessionId: string, code: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "CodingProxySession" SET "upstreamFailure" = ${code}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${sessionId} AND "upstreamFailure" IS NULL
    `;
  }

  async upstreamFailure(sessionId: string): Promise<string | null> {
    const rows = await this.db.$queryRaw<{ upstreamFailure: string | null }[]>`
      SELECT "upstreamFailure" FROM "CodingProxySession" WHERE "id" = ${sessionId}
    `;
    return rows[0]?.upstreamFailure ?? null;
  }

  getRequest(requestId: string): Promise<ProxyRequest | null> {
    return requestById(this.db, requestId);
  }
}
