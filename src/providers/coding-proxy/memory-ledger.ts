import type { LeaseRenewal } from "../../core/request-lease.js";
import {
  normalizeProxyModelTerms,
  type ExpiredRequest,
  type PreviousReply,
  type CreateProxySessionInput,
  type ProxyLedger,
  type ProxyRefusalRecord,
  type ProxyRequest,
  type ProxySession,
  type ProxyUsage,
  type ReserveProxyRequestInput,
  type ReserveProxyRequestResult,
} from "./types.js";

function cloneSession(session: ProxySession): ProxySession {
  return {
    ...session,
    allowedModels: [...session.allowedModels],
    deadlineAt: new Date(session.deadlineAt),
    budgetExhaustedAt: session.budgetExhaustedAt ? new Date(session.budgetExhaustedAt) : null,
    budgetRefusal: session.budgetRefusal ? { ...session.budgetRefusal } : null,
    upstreamFailure: session.upstreamFailure ?? null,
    requestRefusal: session.requestRefusal ?? null,
    terms: session.terms
      ? { version: session.terms.version, entry: { ...session.terms.entry, efforts: [...session.terms.entry.efforts] } }
      : null,
    mcpTools: session.mcpTools ? structuredClone(session.mcpTools) : null,
  };
}

function cloneRequest(request: ProxyRequest): ProxyRequest {
  return {
    ...request,
    pricing: { ...request.pricing },
    usage: request.usage ? { ...request.usage } : undefined,
    ...(request.leaseUntil ? { leaseUntil: new Date(request.leaseUntil) } : {}),
    ...(request.orphanedAt ? { orphanedAt: new Date(request.orphanedAt) } : {}),
  };
}

/** Deterministic contract adapter. Sharing one instance simulates a proxy restart. */
export class MemoryProxyLedger implements ProxyLedger {
  private readonly sessions = new Map<string, ProxySession>();
  private readonly sessionByCapability = new Map<string, string>();
  private readonly sessionByMcpToken = new Map<string, string>();
  private readonly requests = new Map<string, ProxyRequest>();
  private readonly requestBySessionKey = new Map<string, string>();
  private readonly startedAt = new Map<string, Date>();

  constructor(private readonly options: { now?: () => Date } = {}) {}

  /** The ledger's own clock, which leases run on (the database's, for the Prisma ledger). */
  private clock(): Date {
    return this.options.now?.() ?? new Date();
  }

  async createSession(input: CreateProxySessionInput): Promise<void> {
    if ([...this.sessions.values()].some((session) => session.runId === input.runId)) {
      throw new Error("proxy_session_exists");
    }
    if (this.sessionByCapability.has(input.capabilityHash)) throw new Error("proxy_capability_collision");
    if (input.mcpTokenHash !== undefined && this.sessionByMcpToken.has(input.mcpTokenHash)) {
      throw new Error("proxy_mcp_token_collision");
    }
    const session: ProxySession = {
      ...input,
      allowedModels: [...input.allowedModels],
      status: "active",
      terms: input.terms ? normalizeProxyModelTerms(input.terms) : null,
      mcpTools: input.mcpTools ? structuredClone(input.mcpTools) : null,
      mcpTokenHash: input.mcpTokenHash ?? null,
      mcpCallCount: 0,
      runStepsLevel: input.runStepsLevel ?? null,
      workflow: input.workflow === true,
      skills: input.skills === true,
    };
    this.sessions.set(session.id, session);
    this.sessionByCapability.set(session.capabilityHash, session.id);
    if (session.mcpTokenHash !== null) this.sessionByMcpToken.set(session.mcpTokenHash, session.id);
  }

  async findSessionByMcpTokenHash(mcpTokenHash: string): Promise<ProxySession | undefined> {
    const id = this.sessionByMcpToken.get(mcpTokenHash);
    const session = id ? this.sessions.get(id) : undefined;
    return session ? cloneSession(session) : undefined;
  }

  async findSessionByCapabilityHash(capabilityHash: string): Promise<ProxySession | null> {
    const id = this.sessionByCapability.get(capabilityHash);
    const session = id ? this.sessions.get(id) : undefined;
    return session ? cloneSession(session) : null;
  }

  async reserve(input: ReserveProxyRequestInput): Promise<ReserveProxyRequestResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.status === "cancelled") return { outcome: "inactive", reason: "cancelled" };
    if (input.now.getTime() >= session.deadlineAt.getTime()) return { outcome: "inactive", reason: "expired" };
    const lookupKey = `${input.sessionId}\0${input.requestKey}`;
    // The newest attempt of the key. Leases are compared on the ledger's clock, as the database ledger does.
    const existingId = this.requestBySessionKey.get(lookupKey);
    const prior = existingId ? this.requests.get(existingId)! : undefined;
    let attempt = 1;
    let tookOver: { requestId: string } | undefined;
    if (prior) {
      const retryable = input.maxAttempts !== undefined && prior.requestFingerprint === input.requestFingerprint;
      // A row with no lease cannot be told from a live one, and an uncertain row a live proxy settled
      // (a broken stream) is not an orphan: neither is ever taken over.
      const reservedLeased = prior.status === "reserved" && Boolean(prior.leaseUntil);
      const settledOrphan = prior.status === "uncertain" && Boolean(prior.orphanedAt);
      if (!retryable || !(reservedLeased || settledOrphan))
        return { outcome: "duplicate", request: cloneRequest(prior) };
      if (reservedLeased) {
        const remainingMs = prior.leaseUntil!.getTime() - this.clock().getTime();
        if (remainingMs >= 0) {
          return { outcome: "in_progress", request: cloneRequest(prior), retryAfterMs: remainingMs };
        }
      }
      if (prior.attempt >= input.maxAttempts!) return { outcome: "attempts_exhausted", request: cloneRequest(prior) };
      if (reservedLeased) {
        if (input.takeover?.requestId !== prior.id) {
          return {
            outcome: "orphaned",
            orphan: {
              request: cloneRequest(prior),
              runId: session.runId,
              createdAt: new Date(this.startedAt.get(prior.id) ?? 0),
            },
          };
        }
        const { estimate } = input.takeover;
        prior.status = "uncertain";
        prior.leaseUntil = null;
        prior.orphanedAt = this.clock();
        prior.actualCostUsd = estimate.costUsd;
        prior.usage = { ...estimate.usage };
        prior.costEstimated = true;
      }
      attempt = prior.attempt + 1;
      tookOver = { requestId: prior.id };
    }

    let spent = 0;
    let heldReserved = 0;
    let heldUncertain = 0;
    let done = 0;
    for (const request of this.requests.values()) {
      if (request.sessionId !== input.sessionId) continue;
      // An uncertain request settled at an estimate counts at it; one without an estimate keeps its hold.
      const settled = request.status === "completed" || (request.status === "uncertain" && request.costEstimated);
      if (settled) {
        spent += request.actualCostUsd!;
        done += 1;
      } else if (request.status === "reserved") heldReserved += request.reservationUsd;
      else if (request.status === "uncertain") heldUncertain += request.reservationUsd;
    }
    const committedOrHeld = spent + heldReserved + heldUncertain;
    if (committedOrHeld + input.reservationUsd >= session.budgetUsd) {
      const details = {
        budgetUsd: session.budgetUsd,
        spentUsd: spent,
        heldReservedUsd: heldReserved,
        heldUncertainUsd: heldUncertain,
        refusedHoldUsd: input.reservationUsd,
        ...(input.reservationBasis ? { refusedHoldBasis: input.reservationBasis } : {}),
        ...(input.ceilingUsd !== undefined ? { refusedHoldCeilingUsd: input.ceilingUsd } : {}),
        model: input.model,
        turn: done + 1,
      };
      if (!session.budgetExhaustedAt) {
        session.budgetExhaustedAt = new Date(input.now);
        session.budgetRefusal = { source: "proxy", ...details };
      }
      return { outcome: "budget_exhausted", details };
    }

    const { leaseMs, maxAttempts: _maxAttempts, takeover: _takeover, ...rest } = input;
    const request: ProxyRequest = {
      ...rest,
      pricing: { ...input.pricing },
      status: "reserved",
      attempt,
      // A lease needs an owner to renew it: without one the row is unleased, so never swept.
      leaseUntil:
        input.ownerId !== undefined && leaseMs !== undefined ? new Date(this.clock().getTime() + leaseMs) : null,
    };
    this.requests.set(request.id, request);
    this.requestBySessionKey.set(lookupKey, request.id);
    this.startedAt.set(request.id, new Date(input.now));
    return { outcome: "reserved", request: cloneRequest(request), ...(tookOver ? { tookOver } : {}) };
  }

  async complete(
    requestId: string,
    usage: ProxyUsage,
    actualCostUsd: number,
    upstreamStatus: number,
  ): Promise<ProxyRequest> {
    const request = this.requiredRequest(requestId);
    if (request.status === "completed") {
      if (request.actualCostUsd !== actualCostUsd || JSON.stringify(request.usage) !== JSON.stringify(usage)) {
        throw new Error("proxy_completion_conflict");
      }
      return cloneRequest(request);
    }
    if (request.status === "released") throw new Error("proxy_request_released");
    request.status = "completed";
    request.actualCostUsd = actualCostUsd;
    request.usage = { ...usage };
    request.upstreamStatus = upstreamStatus;
    request.costEstimated = false;
    request.leaseUntil = null;
    return cloneRequest(request);
  }

  async release(requestId: string, upstreamStatus: number): Promise<void> {
    const request = this.requiredRequest(requestId);
    if (request.status === "completed" || request.status === "uncertain") return;
    request.status = "released";
    request.upstreamStatus = upstreamStatus;
    request.leaseUntil = null;
  }

  async markUncertain(
    requestId: string,
    upstreamStatus?: number,
    estimate?: { usage: ProxyUsage; costUsd: number },
  ): Promise<void> {
    const request = this.requiredRequest(requestId);
    if (request.status !== "reserved") return;
    request.status = "uncertain";
    request.upstreamStatus = upstreamStatus;
    request.leaseUntil = null;
    if (estimate) {
      request.actualCostUsd = estimate.costUsd;
      request.usage = { ...estimate.usage };
      request.costEstimated = true;
    }
  }

  async renewLeases(ownerId: string, requestIds: string[], leaseMs: number): Promise<LeaseRenewal> {
    const leaseUntil = new Date(this.clock().getTime() + leaseMs);
    const renewed: string[] = [];
    const cancelled: string[] = [];
    for (const id of requestIds) {
      const request = this.requests.get(id);
      if (request?.ownerId === ownerId && request.status === "reserved" && request.leaseUntil) {
        request.leaseUntil = new Date(leaseUntil);
        renewed.push(id);
        if (this.sessions.get(request.sessionId)?.status === "cancelled") cancelled.push(id);
      }
    }
    return { renewed, cancelled };
  }

  async expiredLeases(limit: number): Promise<ExpiredRequest[]> {
    const now = this.clock().getTime();
    return [...this.requests.values()]
      .filter((request) => request.status === "reserved" && request.leaseUntil && request.leaseUntil.getTime() < now)
      .sort((a, b) => a.leaseUntil!.getTime() - b.leaseUntil!.getTime())
      .slice(0, limit)
      .map((request) => ({
        request: cloneRequest(request),
        runId: this.sessions.get(request.sessionId)!.runId,
        createdAt: new Date(this.startedAt.get(request.id) ?? 0),
      }));
  }

  async settleExpired(requestId: string, estimate?: { usage: ProxyUsage; costUsd: number }): Promise<boolean> {
    const request = this.requests.get(requestId);
    if (!request || request.status !== "reserved") return false;
    if (!request.leaseUntil || request.leaseUntil.getTime() >= this.clock().getTime()) return false;
    request.status = "uncertain";
    request.leaseUntil = null;
    request.orphanedAt = this.clock();
    if (estimate) {
      request.actualCostUsd = estimate.costUsd;
      request.usage = { ...estimate.usage };
      request.costEstimated = true;
    }
    return true;
  }

  async settlementHints(sessionId: string, model: string): Promise<{ medianOutputTokens?: number }> {
    const outputs: number[] = [];
    for (const request of this.requests.values()) {
      if (request.sessionId !== sessionId || request.model !== model) continue;
      if (request.status !== "completed" || !request.usage) continue;
      outputs.push(request.usage.outputTokens);
    }
    outputs.sort((a, b) => a - b);
    return {
      // The lower middle for an even count, as Postgres's percentile_disc(0.5).
      ...(outputs.length > 0 ? { medianOutputTokens: outputs[Math.ceil(outputs.length / 2) - 1] } : {}),
    };
  }

  async previousReply(sessionId: string, conversationKey: string): Promise<PreviousReply | null> {
    let latest: ProxyRequest | undefined;
    // Map iteration follows insertion order: the last match is the latest request.
    for (const request of this.requests.values()) {
      if (request.sessionId !== sessionId || request.conversationKey !== conversationKey) continue;
      if (request.status === "completed" || request.status === "uncertain") latest = request;
    }
    if (!latest) return null;
    return {
      model: latest.model,
      status: latest.status as "completed" | "uncertain",
      costEstimated: latest.costEstimated === true,
      ...(latest.usage ? { usage: { ...latest.usage } } : {}),
      requestBytes: latest.requestBytes ?? null,
      startedAt: this.startedAt.get(latest.id) ?? new Date(0),
    };
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.status = "cancelled";
  }

  async budgetExhausted(sessionId: string): Promise<boolean> {
    return Boolean(this.sessions.get(sessionId)?.budgetExhaustedAt);
  }

  async budgetRefusal(sessionId: string): Promise<ProxyRefusalRecord | null> {
    const refusal = this.sessions.get(sessionId)?.budgetRefusal;
    return refusal ? { ...refusal } : null;
  }

  async recordUpstreamFailure(sessionId: string, code: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.upstreamFailure ??= code;
  }

  async recordRequestRefusal(sessionId: string, code: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.requestRefusal ??= code;
  }

  async requestRefusal(sessionId: string): Promise<string | null> {
    return this.sessions.get(sessionId)?.requestRefusal ?? null;
  }

  async upstreamFailure(sessionId: string): Promise<string | null> {
    return this.sessions.get(sessionId)?.upstreamFailure ?? null;
  }

  async getRequest(requestId: string): Promise<ProxyRequest | null> {
    const request = this.requests.get(requestId);
    return request ? cloneRequest(request) : null;
  }

  private requiredRequest(requestId: string): ProxyRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error("unknown_proxy_request");
    return request;
  }
}
