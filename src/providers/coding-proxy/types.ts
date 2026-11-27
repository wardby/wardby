import { parseStoredEntry, type CatalogEntry } from "../llm/catalog-types.js";
import type { RunStepsLevel } from "../../core/run-steps/config.js";
import type { ModelPricing } from "../llm/pricing-core.js";
import type { ProxyRefusalDetails } from "../../core/budget-events.js";
import type { LeaseRenewal } from "../../core/request-lease.js";
import type { CodingToolPin, NativeToolPin } from "../../core/coding-native-tools.js";
import type { McpToolPin } from "../../core/mcp-tools.js";
import type { WebTools } from "../../coding/google-web-tools.js";
/**
 * The longest tool description (and other tool text) the proxy accepts in a request, in characters.
 * A native tool over it is refused at attach on a Claude Code agent and left out of its runs.
 */
export const MAX_TOOL_TEXT_BYTES = 256 * 1024;

/** A native pin as the proxy holds it: name, description and schema only, never the pinned code or grants. */
export type ListedNativeToolPin = Omit<NativeToolPin, "pinned">;
/** A session's pin as the proxy reads it. */
export type ListedToolPin = McpToolPin | ListedNativeToolPin;

/**
 * The pins as the proxy may hold them: a native pin keeps its identifying fields and definition only,
 * so the tool's code and grants (fixed at dispatch for the gateway) never reach the proxy process.
 */
export function listedToolPins(pins: readonly CodingToolPin[]): ListedToolPin[] {
  return pins.map((pin) => {
    if ((pin as { kind?: unknown }).kind !== "native") return structuredClone(pin);
    const { kind, exposedName, toolId, toolName, definition } = pin as NativeToolPin;
    return structuredClone({ kind, exposedName, toolId, toolName, definition });
  });
}

export type ProxySessionStatus = "active" | "cancelled";
export type ProxyRequestStatus = "reserved" | "completed" | "released" | "uncertain";
export const PROXY_PROTOCOLS = ["openai-responses", "anthropic-messages", "gemini-generate-content"] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];

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
  /**
   * SHA-256 (base64url) of the run's tunnel token (deriveTunnelToken). Only findSessionByTunnelTokenHash
   * returns it; null on sessions from before the tunnel.
   */
  tunnelTokenHash?: string | null;
  /**
   * The tunnel host patterns the run was given at dispatch (codingProfile.tunnelHosts within the ceiling then).
   * Only findSessionByTunnelTokenHash reads them; empty when the run has none, and on older sessions.
   */
  tunnelHosts?: string[];
  /** When the ledger first refused a request of this session for budget. */
  budgetExhaustedAt?: Date | null;
  /** The numbers behind the first budget refusal, set with budgetExhaustedAt. */
  budgetRefusal?: ProxyRefusalRecord | null;
  /** The code of the first upstream failure the proxy relayed for this session. */
  upstreamFailure?: string | null;
  /** The proxy's own first refusal of a request of this session (a fixed code, e.g. tools_not_allowed). */
  requestRefusal?: string | null;
  /** The run's catalog entry, copied at session creation; null on sessions from before the catalog. */
  terms?: ProxyModelTerms | null;
  /**
   * The run's pinned MCP and native tools as listed (no URLs, secrets, tool code or grants); null when
   * the run has none, and on older sessions.
   */
  mcpTools: ListedToolPin[] | null;
  /** SHA-256 (base64url) of the run's MCP token; null when the run has no MCP tools. */
  mcpTokenHash: string | null;
  /** The run's MCP tools/call count so far. */
  mcpCallCount: number;
  /** The run's Run.runStepsLevel, copied at session creation; null on sessions from before run steps detail. */
  runStepsLevel: RunStepsLevel | null;
  /** A workflow run (#582): its requests may use the Workflow tool's shapes. False on older sessions. */
  workflow: boolean;
  /** Native mode with repository skills (#582): its requests may use the Skill tool. False on older sessions. */
  skills: boolean;
  /**
   * Claude Code or Gemini CLI sub-agents on (codingProfile.subAgents): an Anthropic session's requests may use
   * the Agent tool. False on older sessions.
   */
  subAgents: boolean;
  /** Gemini's server-side web tools this run may use (gemini-generate-content only); "off" on other and older sessions. */
  webTools: WebTools;
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
  /** The request's output cap, kept so an orphaned request can be estimated. */
  maxOutputTokens?: number;
  /** The proxy process that reserved the request; kept after it settles. */
  ownerId?: string;
  /** While reserved, when the owner's lease runs out; null once settled, and on rows from before leases. */
  leaseUntil?: Date | null;
  /** Which try of this requestKey the row is: 1, then one more per takeover of an orphaned row. */
  attempt: number;
  /** When the row was settled because its owner's lease ran out; unset for any other row. */
  orphanedAt?: Date | null;
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
  /** When the previous request was reserved: the prompt cache was last refreshed around then. */
  startedAt: Date;
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
  /** SHA-256 (base64url) of the run's tunnel token; absent when the session cannot open tunnels. */
  tunnelTokenHash?: string;
  /** The run's tunnel host patterns, pinned at dispatch (normalised, at most MAX_TUNNEL_HOSTS); absent = none. */
  tunnelHosts?: string[];
  terms?: ProxyModelTerms;
  /** The run's pinned MCP tools; set together with mcpTokenHash, and only when there is at least one. */
  mcpTools?: CodingToolPin[];
  /** SHA-256 (base64url) of the run's MCP token (mcpTokenHash in src/coding/mcp-token.ts). */
  mcpTokenHash?: string;
  /** The run's level, fixed at dispatch; absent counts as summary. */
  runStepsLevel?: RunStepsLevel;
  /** A workflow run (#582); absent = false. */
  workflow?: boolean;
  /** Native mode with repository skills on; absent = false. */
  skills?: boolean;
  /** Sub-agents on; absent = false. */
  subAgents?: boolean;
  /** Gemini's server-side web tools the run may use; absent = "off". */
  webTools?: WebTools;
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
  maxOutputTokens?: number;
  /** The reserving proxy process. With leaseMs, the row is leased to it; without, it has no lease and is never swept. */
  ownerId?: string;
  /** How long the lease lasts from now, on the ledger's clock. */
  leaseMs?: number;
  /** Tries one requestKey may have. Without it a duplicate of a reserved row is never taken over. */
  maxAttempts?: number;
  /**
   * Take over this orphaned request (the one an earlier reserve returned as `orphaned`): in the same
   * transaction, settle it at the estimate and reserve the next attempt. The estimate is the proxy's;
   * the ledger only applies it while the row is still the key's newest, reserved and lease-expired.
   */
  takeover?: { requestId: string; estimate: { usage: ProxyUsage; costUsd: number } };
}

/** A reserved request whose lease has run out: its owner is presumed dead. */
export interface ExpiredRequest {
  request: ProxyRequest;
  runId: string;
  /** When the request was reserved, for the clock of its estimate. */
  createdAt: Date;
}

/** What the proxy knows about a refusal: the numbers only; names and the binding limit are the control plane's. */
export type ProxyRefusalRecord = Omit<ProxyRefusalDetails, "agentBudgetUsd" | "groupName" | "leadAgentName">;

export type ReserveProxyRequestResult =
  | { outcome: "reserved"; request: ProxyRequest; tookOver?: { requestId: string } }
  | { outcome: "duplicate"; request: ProxyRequest }
  /** The key's newest row is reserved and its owner's lease is still running: nothing may be sent upstream yet. */
  | { outcome: "in_progress"; request: ProxyRequest; retryAfterMs: number }
  /** The key's newest row is reserved and its lease ran out: the owner is presumed dead. Retry with `takeover`. */
  | { outcome: "orphaned"; orphan: ExpiredRequest }
  /** The key has used all its attempts. */
  | { outcome: "attempts_exhausted"; request: ProxyRequest }
  | { outcome: "budget_exhausted"; details: Omit<ProxyRefusalRecord, "source"> }
  | { outcome: "inactive"; reason: "cancelled" | "expired" };

export interface ProxyLedger {
  createSession(input: CreateProxySessionInput): Promise<void>;
  findSessionByCapabilityHash(capabilityHash: string): Promise<ProxySession | null>;
  /** The session whose MCP token hashes to this; any status (the caller checks it is active and in time). */
  findSessionByMcpTokenHash(mcpTokenHash: string): Promise<ProxySession | undefined>;
  /** The session whose tunnel token hashes to this, with its tunnelTokenHash; any status (the caller checks it is active and in time). */
  findSessionByTunnelTokenHash(tunnelTokenHash: string): Promise<ProxySession | undefined>;
  /** Whether the run's session exists, is active and has not passed its deadline, on the ledger's clock. */
  sessionActiveForRun(runId: string): Promise<boolean>;
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
   * What an interrupted reply's output can be estimated from: the median output tokens of the
   * session's completed replies for this model. Its input comes from previousReply.
   */
  settlementHints(sessionId: string, model: string): Promise<{ medianOutputTokens?: number }>;
  /** The latest completed or uncertain request of a conversation, or null when it has none. */
  previousReply(sessionId: string, conversationKey: string): Promise<PreviousReply | null>;
  /**
   * Extends the lease of these reserved requests to leaseMs from now. Only rows owned by ownerId
   * move: a row another process leased, or one already settled, is left alone and is not in the
   * result's `renewed`, which is how its owner learns it lost it. `cancelled` lists renewed rows
   * whose session was cancelled.
   */
  renewLeases(ownerId: string, requestIds: string[], leaseMs: number): Promise<LeaseRenewal>;
  /** Up to `limit` reserved requests whose lease has run out, oldest lease first. Rows with no lease are never listed. */
  expiredLeases(limit: number): Promise<ExpiredRequest[]>;
  /**
   * Settles a request whose lease has run out as uncertain, at the estimate (it then counts at it,
   * not at its hold) or, without one, holding its full hold. Applies only while the row is still
   * reserved and its lease still expired, so an owner that renewed or settled it in the meantime
   * wins. True when this call settled it.
   */
  settleExpired(requestId: string, estimate?: { usage: ProxyUsage; costUsd: number }): Promise<boolean>;
  cancelSession(sessionId: string): Promise<void>;
  /** Whether a request of this session was ever refused for budget. */
  budgetExhausted(sessionId: string): Promise<boolean>;
  /** The numbers behind the session's first budget refusal, if any. */
  budgetRefusal(sessionId: string): Promise<ProxyRefusalRecord | null>;
  /** Records an upstream failure code on the session; only the first one is kept. */
  recordUpstreamFailure(sessionId: string, code: string): Promise<void>;
  /** The first upstream failure code relayed for this session, if any. */
  upstreamFailure(sessionId: string): Promise<string | null>;
  /** Records the proxy's refusal of a request (a fixed code); only the first one is kept. */
  recordRequestRefusal(sessionId: string, code: string): Promise<void>;
  /** The proxy's first request refusal for this session, if any. */
  requestRefusal(sessionId: string): Promise<string | null>;
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
    | "request.taken_over"
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
  /** For request.taken_over: the orphaned request this one replaces, and which try this is. */
  previousRequestId?: string;
  attempt?: number;
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
