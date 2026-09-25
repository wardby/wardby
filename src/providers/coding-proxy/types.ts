import type { ModelPricing } from "../llm/pricing.js";

export type ProxySessionStatus = "active" | "cancelled";
export type ProxyRequestStatus = "reserved" | "completed" | "released" | "uncertain";
export type ProxyProtocol = "openai-responses" | "anthropic-messages";

export interface PricingSnapshot extends ModelPricing {
  version: string;
}

export interface ProxyUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface ProxySession {
  id: string;
  runId: string;
  capabilityHash: string;
  credentialRef: string;
  protocol: ProxyProtocol;
  allowedModels: string[];
  deadlineAt: Date;
  budgetUsd: number;
  status: ProxySessionStatus;
  registryTokenHash?: string | null;
}

export interface ProxyRequest {
  id: string;
  sessionId: string;
  requestKey: string;
  requestFingerprint: string;
  model: string;
  status: ProxyRequestStatus;
  reservationUsd: number;
  actualCostUsd?: number;
  pricing: PricingSnapshot;
  usage?: ProxyUsage;
  upstreamStatus?: number;
}

export interface CreateProxySessionInput {
  id: string;
  runId: string;
  capabilityHash: string;
  credentialRef: string;
  protocol: ProxyProtocol;
  allowedModels: string[];
  deadlineAt: Date;
  budgetUsd: number;
  registryTokenHash: string;
}

export interface ReserveProxyRequestInput {
  id: string;
  sessionId: string;
  requestKey: string;
  requestFingerprint: string;
  model: string;
  reservationUsd: number;
  pricing: PricingSnapshot;
  now: Date;
}

export type ReserveProxyRequestResult =
  | { outcome: "reserved"; request: ProxyRequest }
  | { outcome: "duplicate"; request: ProxyRequest }
  | { outcome: "budget_exhausted" }
  | { outcome: "inactive"; reason: "cancelled" | "expired" };

export interface ProxyLedger {
  createSession(input: CreateProxySessionInput): Promise<void>;
  findSessionByCapabilityHash(capabilityHash: string): Promise<ProxySession | null>;
  reserve(input: ReserveProxyRequestInput): Promise<ReserveProxyRequestResult>;
  complete(requestId: string, usage: ProxyUsage, actualCostUsd: number, upstreamStatus: number): Promise<ProxyRequest>;
  release(requestId: string, upstreamStatus: number): Promise<void>;
  markUncertain(requestId: string, upstreamStatus?: number): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  getRequest(requestId: string): Promise<ProxyRequest | null>;
}

export interface ProxyAuditEvent {
  type:
    | "session.created"
    | "session.cancelled"
    | "request.reserved"
    | "request.rejected"
    | "request.released"
    | "request.uncertain"
    | "response.completed";
  runId: string;
  requestId?: string;
  model?: string;
  status?: number;
  reason?: string;
  reservationUsd?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type ProxyAuditSink = (event: ProxyAuditEvent) => void;

export interface CredentialResolver {
  resolve(reference: string): Promise<string>;
}
