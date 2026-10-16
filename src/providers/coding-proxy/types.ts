import { parseStoredEntry, type CatalogEntry } from "../llm/catalog-types.js";
import type { ModelPricing } from "../llm/pricing-core.js";
import type { ProxyRefusalDetails } from "../../core/budget-events.js";

export type ProxySessionStatus = "active" | "cancelled";
export type ProxyRequestStatus = "reserved" | "completed" | "released" | "uncertain";
export type ProxyProtocol = "openai-responses" | "anthropic-messages";

export interface PricingSnapshot extends ModelPricing {
  version: string;
}

/** The model terms a coding run was dispatched under: its catalog entry and that entry's price version. */
export interface ProxyModelTerms {
  version: string;
  entry: CatalogEntry;
}

/**
 * Validates and copies model terms, for both ledgers on write and the database ledger on read.
 * Throws invalid_proxy_session_terms: unreadable terms must refuse the session, never fall back.
 */
export function normalizeProxyModelTerms(terms: { version: unknown; entry: unknown }): ProxyModelTerms {
  const entry = parseStoredEntry(terms.entry);
  if (typeof terms.version !== "string" || terms.version.length === 0 || !entry) {
    throw new Error("invalid_proxy_session_terms");
  }
  return { version: terms.version, entry };
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
  /** When the ledger first refused a request of this session for budget. */
  budgetExhaustedAt?: Date | null;
  /** The numbers behind the first budget refusal, set with budgetExhaustedAt. */
  budgetRefusal?: ProxyRefusalRecord | null;
  /** The code of the first upstream failure the proxy relayed for this session. */
  upstreamFailure?: string | null;
  /** The run's catalog entry, copied at session creation; null on sessions from before the catalog. */
  terms?: ProxyModelTerms | null;
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
  /** An uncertain request settled at an estimate: actualCostUsd and usage are estimated, not reported. */
  costEstimated?: boolean;
  requestBytes?: number;
  ceilingUsd?: number;
  reservationBasis?: ReservationBasis;
  conversationKey?: string | null;
}

export type ReservationBasis = "cached" | "full";

/** The latest finished (completed or uncertain) request of a conversation, for the next request's hold. */
export interface PreviousReply {
  model: string;
  status: "completed" | "uncertain";
  costEstimated: boolean;
  usage?: ProxyUsage;
  /** UTF-8 bytes of the request body the proxy forwarded; null on rows from before cache-aware holds. */
  requestBytes: number | null;
  completedAt: Date | null;
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
  terms?: ProxyModelTerms;
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
  requestBytes?: number;
  ceilingUsd?: number;
  reservationBasis?: ReservationBasis;
  conversationKey?: string | null;
}

/** What the proxy knows about a refusal: the numbers only; names and the binding limit are the control plane's. */
export type ProxyRefusalRecord = Omit<ProxyRefusalDetails, "agentBudgetUsd" | "groupName" | "leadAgentName">;

export type ReserveProxyRequestResult =
  | { outcome: "reserved"; request: ProxyRequest }
  | { outcome: "duplicate"; request: ProxyRequest }
  | { outcome: "budget_exhausted"; details: Omit<ProxyRefusalRecord, "source"> }
  | { outcome: "inactive"; reason: "cancelled" | "expired" };

export interface ProxyLedger {
  createSession(input: CreateProxySessionInput): Promise<void>;
  findSessionByCapabilityHash(capabilityHash: string): Promise<ProxySession | null>;
  reserve(input: ReserveProxyRequestInput): Promise<ReserveProxyRequestResult>;
  complete(requestId: string, usage: ProxyUsage, actualCostUsd: number, upstreamStatus: number): Promise<ProxyRequest>;
  release(requestId: string, upstreamStatus: number): Promise<void>;
  /**
   * Marks a reserved request uncertain. With an estimate it is also settled at that cost (and
   * counts at it, not at its hold); without one it keeps its full hold.
   */
  markUncertain(
    requestId: string,
    upstreamStatus?: number,
    estimate?: { usage: ProxyUsage; costUsd: number },
  ): Promise<void>;
  /**
   * What an interrupted reply can be estimated from: the usage of the session's latest completed,
   * non-estimated reply for this model, and the median output tokens of its completed replies.
   */
  settlementHints(sessionId: string, model: string): Promise<{ previous?: ProxyUsage; medianOutputTokens?: number }>;
  /** The latest completed or uncertain request of a conversation, or null when it has none. */
  previousReply(sessionId: string, conversationKey: string): Promise<PreviousReply | null>;
  cancelSession(sessionId: string): Promise<void>;
  /** Whether a request of this session was ever refused for budget. */
  budgetExhausted(sessionId: string): Promise<boolean>;
  /** The numbers behind the session's first budget refusal, if any. */
  budgetRefusal(sessionId: string): Promise<ProxyRefusalRecord | null>;
  /** Records an upstream failure code on the session; only the first one is kept. */
  recordUpstreamFailure(sessionId: string, code: string): Promise<void>;
  /** The first upstream failure code relayed for this session, if any. */
  upstreamFailure(sessionId: string): Promise<string | null>;
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
  /** For request.reserved and a budget refusal: the worst-case hold and how the hold was priced. */
  ceilingUsd?: number;
  reservationBasis?: ReservationBasis;
  /** Why the hold fell back to the ceiling (basis "full"). */
  holdFallback?: string;
  /** Basis "cached": tokens priced at the cache-read rate, and at the input + cache-write rates. */
  holdCachedTokens?: number;
  holdUncachedTokens?: number;
  /** For response.completed: how much the reply cost above its hold (reason "reservation_exceeded"). */
  overshootUsd?: number;
  /** For a budget refusal: the numbers behind it. */
  budgetUsd?: number;
  spentUsd?: number;
  heldReservedUsd?: number;
  heldUncertainUsd?: number;
  turn?: number;
  costUsd?: number;
  /** For request.uncertain: the estimated cost it was settled at, when one could be made. */
  estimatedCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** For a failed stream: the upstream response's content type and encoding headers, for diagnosis. */
  contentType?: string;
  contentEncoding?: string;
  /** Set on every event while the load-test mock upstream is enabled. */
  mockUpstream?: boolean;
}

export type ProxyAuditSink = (event: ProxyAuditEvent) => void;

export interface CredentialResolver {
  resolve(reference: string): Promise<string>;
}
