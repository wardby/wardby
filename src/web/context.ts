import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import type { loadAgentSecretValues } from "../core/secret-guard.js";
import type { Viewer } from "../core/documents/access.js";
import { validateSessionLink } from "../core/documents/share-links.js";
import { logger } from "../core/logger.js";
import { RateLimitError, type RateLimiter } from "../mcp/auth/self-hosted/rate-limit.js";
import type { OidcLogin } from "./oidc-login.js";
import type { GuestRateLimits } from "./rate-limits.js";
import {
  readWebSession,
  webCookieOptions,
  webSessionCsrf,
  type SelfHostedSessionSource,
  type WebCookieOptions,
  type WebSessionView,
} from "./session.js";

const webLog = logger.child({ module: "web" });

export type WebCipher = Parameters<typeof loadAgentSecretValues>[1];

/**
 * Sends threads to the document's agent (src/core/documents/agent-loop.ts
 * sendThreadsToAgent, wired in src/mcp/index.ts); absent = 501. Contract: every caller has already required `write` access
 * on the document for this viewer (requireDocumentAccess), and an
 * implementation re-checks it before starting a run.
 */
export type SendThreads = (input: { documentId: string; threadIds: string[]; viewer: Viewer }) => Promise<unknown>;

export interface WebDeps {
  db: PrismaClient;
  cipher: WebCipher;
  /** The canonical URI (MCP_CANONICAL_URI); its origin serves the pages. */
  canonicalUri: string;
  /** AUTH_PROVIDER: delegating mounts the OIDC routes; self-hosted bridges its own login. */
  authMode: "delegating" | "self-hosted";
  /** Self-hosted mode: the provider whose login session the pages bridge. */
  selfHosted?: SelfHostedSessionSource;
  /** Delegating mode: browser sign-in against AUTH_ISSUER. */
  oidc?: OidcLogin;
  /** Where the browser bundle and manifest.json live; default dist/web-assets. */
  assetsRoot?: string;
  sendThreads?: SendThreads;
  /** Counts guest registrations and comments; default: the Postgres limiter (rate-limits.ts). */
  rateLimiter?: RateLimiter;
  /** Tests only: lower or raise individual guest limits; operators always get GUEST_RATE_LIMITS. */
  guestLimits?: Partial<GuestRateLimits>;
}

/** Who a request is from, after the session and its share link are re-validated. */
export type WebContext =
  | { kind: "none" }
  | {
      kind: "member";
      session: WebSessionView;
      csrf: string;
      principalId: string;
      viewer: Extract<Viewer, { kind: "principal" }>;
    }
  | {
      kind: "guest";
      session: WebSessionView;
      csrf: string;
      guestId: string;
      shareLinkId: string;
      documentId: string;
      viewer: Extract<Viewer, { kind: "guest" }>;
    };

export const cookieOptions = (deps: WebDeps): WebCookieOptions => webCookieOptions(deps.canonicalUri);

/**
 * The request's live web session as a viewer. Every request re-validates the
 * session's share link (R9a): a revoked or expired link, or a guest that no
 * longer belongs to it, makes the session count as absent.
 */
export async function resolveContext(req: IncomingMessage, deps: WebDeps): Promise<WebContext> {
  const options = cookieOptions(deps);
  const session = await readWebSession(deps.db, req.headers.cookie, options);
  if (!session) return { kind: "none" };
  const csrf = webSessionCsrf(req.headers.cookie, options);
  if (!csrf) return { kind: "none" };
  const state = await validateSessionLink(deps.db, session);
  if (state.kind === "dead") return { kind: "none" };
  if (session.guestId) {
    if (state.kind !== "link" || (state.permission !== "view" && state.permission !== "comment")) {
      return { kind: "none" };
    }
    return {
      kind: "guest",
      session,
      csrf,
      guestId: session.guestId,
      shareLinkId: state.link.id,
      documentId: state.documentId,
      viewer: { kind: "guest", guestId: session.guestId, shareLinkId: state.link.id, permission: state.permission },
    };
  }
  if (!session.principalId) return { kind: "none" };
  return {
    kind: "member",
    session,
    csrf,
    principalId: session.principalId,
    // A member's session is principal-only: link elevation is per request (x-wardby-share).
    viewer: { kind: "principal", principalId: session.principalId },
  };
}

/** Appends a Set-Cookie value to those already set on the response. */
export function addCookie(res: ServerResponse, value: string): void {
  const existing = res.getHeader("set-cookie");
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader("set-cookie", [...list, value]);
}

export function sendWebJson(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    })
    .end(JSON.stringify(body));
}

/** Request-shape problems a handler reports with a fixed code. */
export class WebError extends Error {}

/**
 * Every code a web route may answer with, and its HTTP status. Anything else
 * becomes `internal_error`: no other error text ever reaches a response.
 */
const STATUS = {
  invalid_request: 400,
  comment_anchor_invalid: 400,
  comment_too_long: 400,
  document_not_agent_linked: 400,
  guest_name_invalid: 400,
  guest_email_invalid: 400,
  web_login_failed: 400,
  web_login_state_invalid: 400,
  web_session_required: 401,
  document_access_denied: 403,
  document_agent_unavailable: 403,
  comment_edit_forbidden: 403,
  web_csrf_failed: 403,
  web_origin_rejected: 403,
  not_found: 404,
  document_not_found: 404,
  comment_not_found: 404,
  share_link_invalid: 404,
  document_version_conflict: 409,
  comment_thread_closed: 409,
  comment_thread_already_sent: 409,
  document_too_large: 413,
  document_too_large_for_agent: 413,
  expected_json_object: 415,
  document_send_not_available: 501,
  web_login_not_configured: 503,
  web_rate_limited: 429,
  comment_send_rate_limited: 429,
  web_assets_missing: 503,
  document_send_failed: 503,
} satisfies Record<string, number>;

/** The code and status for an error. Unknown errors are logged by name only (their text may carry user content). */
export function errorCode(
  err: unknown,
  fallback?: keyof typeof STATUS,
): { code: string; status: number; requestId?: string } {
  if (err instanceof RateLimitError) return { code: "web_rate_limited", status: STATUS.web_rate_limited };
  const message = err instanceof Error ? err.message : "";
  if (Object.hasOwn(STATUS, message)) return { code: message, status: (STATUS as Record<string, number>)[message] };
  const requestId = randomUUID();
  webLog.error({ requestId, errorName: err instanceof Error ? err.name : typeof err }, "web request failed");
  if (fallback) return { code: fallback, status: STATUS[fallback] };
  return { code: "internal_error", status: 500, requestId };
}

export function isJsonObject(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === "object" && !Array.isArray(body) && !(body instanceof URLSearchParams);
}
