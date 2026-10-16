import {
  normalizeProxyModelTerms,
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
    terms: session.terms
      ? { version: session.terms.version, entry: { ...session.terms.entry, efforts: [...session.terms.entry.efforts] } }
      : null,
  };
}

function cloneRequest(request: ProxyRequest): ProxyRequest {
  return {
    ...request,
    pricing: { ...request.pricing },
    usage: request.usage ? { ...request.usage } : undefined,
  };
}

/** Deterministic contract adapter. Sharing one instance simulates a proxy restart. */
export class MemoryProxyLedger implements ProxyLedger {
  private readonly sessions = new Map<string, ProxySession>();
  private readonly sessionByCapability = new Map<string, string>();
  private readonly requests = new Map<string, ProxyRequest>();
  private readonly requestBySessionKey = new Map<string, string>();
  private readonly completedAt = new Map<string, Date>();

  constructor(private readonly options: { now?: () => Date } = {}) {}

  async createSession(input: CreateProxySessionInput): Promise<void> {
    if ([...this.sessions.values()].some((session) => session.runId === input.runId)) {
      throw new Error("proxy_session_exists");
    }
    if (this.sessionByCapability.has(input.capabilityHash)) throw new Error("proxy_capability_collision");
    const session: ProxySession = {
      ...input,
      allowedModels: [...input.allowedModels],
      status: "active",
      terms: input.terms ? normalizeProxyModelTerms(input.terms) : null,
    };
    this.sessions.set(session.id, session);
    this.sessionByCapability.set(session.capabilityHash, session.id);
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
    const existingId = this.requestBySessionKey.get(lookupKey);
    if (existingId) return { outcome: "duplicate", request: cloneRequest(this.requests.get(existingId)!) };

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

    const request: ProxyRequest = { ...input, pricing: { ...input.pricing }, status: "reserved" };
    this.requests.set(request.id, request);
    this.requestBySessionKey.set(lookupKey, request.id);
    return { outcome: "reserved", request: cloneRequest(request) };
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
    this.completedAt.set(requestId, this.options.now?.() ?? new Date());
    return cloneRequest(request);
  }

  async release(requestId: string, upstreamStatus: number): Promise<void> {
    const request = this.requiredRequest(requestId);
    if (request.status === "completed" || request.status === "uncertain") return;
    request.status = "released";
    request.upstreamStatus = upstreamStatus;
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
    if (estimate) {
      request.actualCostUsd = estimate.costUsd;
      request.usage = { ...estimate.usage };
      request.costEstimated = true;
    }
  }

  async settlementHints(
    sessionId: string,
    model: string,
  ): Promise<{ previous?: ProxyUsage; medianOutputTokens?: number }> {
    let previous: ProxyUsage | undefined;
    const outputs: number[] = [];
    // Map iteration follows insertion order, so the last match is the latest completed reply.
    for (const request of this.requests.values()) {
      if (request.sessionId !== sessionId || request.status !== "completed" || !request.usage) continue;
      outputs.push(request.usage.outputTokens);
      if (request.model === model && !request.costEstimated) previous = request.usage;
    }
    outputs.sort((a, b) => a - b);
    return {
      ...(previous ? { previous: { ...previous } } : {}),
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
      completedAt: this.completedAt.get(latest.id) ?? null,
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
