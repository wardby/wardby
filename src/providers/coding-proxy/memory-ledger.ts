import type {
  CreateProxySessionInput,
  ProxyLedger,
  ProxyRequest,
  ProxySession,
  ProxyUsage,
  ReserveProxyRequestInput,
  ReserveProxyRequestResult,
} from "./types.js";

function cloneSession(session: ProxySession): ProxySession {
  return { ...session, allowedModels: [...session.allowedModels], deadlineAt: new Date(session.deadlineAt) };
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

  async createSession(input: CreateProxySessionInput): Promise<void> {
    if ([...this.sessions.values()].some((session) => session.runId === input.runId)) {
      throw new Error("proxy_session_exists");
    }
    if (this.sessionByCapability.has(input.capabilityHash)) throw new Error("proxy_capability_collision");
    const session: ProxySession = { ...input, allowedModels: [...input.allowedModels], status: "active" };
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

    let committedOrHeld = 0;
    for (const request of this.requests.values()) {
      if (request.sessionId !== input.sessionId) continue;
      if (request.status === "completed") committedOrHeld += request.actualCostUsd!;
      if (request.status === "reserved" || request.status === "uncertain") committedOrHeld += request.reservationUsd;
    }
    if (committedOrHeld + input.reservationUsd >= session.budgetUsd) return { outcome: "budget_exhausted" };

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
    return cloneRequest(request);
  }

  async release(requestId: string, upstreamStatus: number): Promise<void> {
    const request = this.requiredRequest(requestId);
    if (request.status === "completed" || request.status === "uncertain") return;
    request.status = "released";
    request.upstreamStatus = upstreamStatus;
  }

  async markUncertain(requestId: string, upstreamStatus?: number): Promise<void> {
    const request = this.requiredRequest(requestId);
    if (request.status !== "reserved") return;
    request.status = "uncertain";
    request.upstreamStatus = upstreamStatus;
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.status = "cancelled";
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
