/**
 * The two routes `wardby secret connect` calls with a loopback link (oauth-loopback-link.ts):
 *
 *  - POST /oauth/loopback/start    `{ redirectUri }` -> `{ authorizeUrl, expiresAt }`
 *  - POST /oauth/loopback/complete `{ code, state, iss? }` -> `{ confirmationCode }`
 *
 * Served by both hosts: the HTTP transport (streamable-http.ts, behind its canonical-Host check and
 * body limits) and, on stdio, the loopback link host (stdio-link-host.ts). The link is the
 * credential and travels only in `Authorization: Bearer`; it is never read from a query string.
 *
 * Nothing here logs or echoes the link, the authorization code, the state or the issuer: every
 * refusal is a fixed `{ error }` code (plus, for a refused start, create_secret's fixed message).
 * The start runs the existing connect (startOAuthSecretConnect) for the link's principal and secret
 * name only, with the CLI's loopback redirect URI, and marks the request as loopback-started. The
 * complete runs the shared callback step (completeOAuthCallback) for such a request only, and only
 * when it belongs to the link's principal and secret name; any other state is "invalid" and is left
 * as it was. The owner still confirms the code with create_secret.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import {
  completeOAuthCallback,
  OAUTH_ISS_MAX_LENGTH,
  type OAuthLinkAdapter,
  type OAuthLinkDb,
} from "../../core/oauth-link.js";
import {
  OAUTH_SECRET_PURPOSE,
  oauthSecretAdapter,
  parseOAuthSecretContext,
  startOAuthSecretConnect,
} from "../../core/oauth-secrets.js";
import { logger } from "../../core/logger.js";
import type { SafeFetchOptions, safeFetch } from "../../sandbox/safe-fetch.js";
import type { SecretCipher } from "../../providers/secrets/types.js";
import { HTTP_LIMITS, HttpBoundaryError, parseBody, readBody } from "../transport/http-limits.js";
import type { StdioBearerRoute } from "../transport/stdio-link-host.js";
import { describeOAuthSecretError } from "./oauth-secret-errors.js";
import {
  isOAuthLoopbackRedirectUri,
  OAUTH_LOOPBACK_COMPLETE_PATH,
  OAUTH_LOOPBACK_START_PATH,
  verifyOAuthLoopbackLink,
  type OAuthLoopbackLinkAudience,
  type OAuthLoopbackLinkPayload,
} from "./oauth-loopback-link.js";

const log = logger.child({ module: "oauth-loopback" });

/** Largest request body either route accepts (both bodies are a few short strings). */
export const OAUTH_LOOPBACK_BODY_LIMIT = 8 * 1024;
/** Longest `code` and `state` accepted: completeOAuthCallback's own limit. */
const CODE_STATE_MAX_LENGTH = 256;

/** Every refusal code the routes answer with, besides create_secret's own codes for a refused start. */
export type OAuthLoopbackRefusal =
  | "method_not_allowed"
  | "link_required"
  | "link_invalid"
  | "expected_json"
  | "invalid_request"
  | "redirect_uri_invalid"
  | "invalid"
  | "failed"
  | "internal_error";

export interface OAuthLoopbackRouteDeps {
  /** The MCP server's requestState verify. */
  verify: (token: string) => Promise<unknown>;
  /** The host serving the routes: only links minted for it are accepted. */
  audience: OAuthLoopbackLinkAudience;
  db: OAuthLinkDb & Pick<PrismaClient, "secret">;
  cipher: SecretCipher;
  /** The MCP server path's fetch policy, as create_secret's web flow uses. */
  options?: SafeFetchOptions;
  fetchImpl?: typeof safeFetch;
  now?: () => Date;
}

/** What a host hands a route: the method, the Bearer token (null when absent), and the parsed body. */
export interface OAuthLoopbackRequest {
  method: string | undefined;
  token: string | null;
  /** The parsed body: a JSON value, URLSearchParams for a form, or undefined for none. */
  body: unknown;
}

const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...HEADERS, ...headers }).end(JSON.stringify(body));
}

function refuse(res: ServerResponse, status: number, error: OAuthLoopbackRefusal, headers?: Record<string, string>) {
  send(res, status, { error }, headers);
}

/** The method, link and JSON-object checks both routes share: the link's payload, or a refusal sent. */
async function admit(
  request: OAuthLoopbackRequest,
  res: ServerResponse,
  deps: OAuthLoopbackRouteDeps,
): Promise<{ link: OAuthLoopbackLinkPayload; body: Record<string, unknown> } | undefined> {
  if (request.method !== "POST") {
    refuse(res, 405, "method_not_allowed", { allow: "POST" });
    return undefined;
  }
  if (request.token === null) {
    refuse(res, 401, "link_required", { "www-authenticate": "Bearer" });
    return undefined;
  }
  const verified = await verifyOAuthLoopbackLink(request.token, {
    verify: deps.verify,
    audience: deps.audience,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!verified.ok) {
    refuse(res, 403, verified.error);
    return undefined;
  }
  if (request.body instanceof URLSearchParams) {
    refuse(res, 415, "expected_json");
    return undefined;
  }
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    refuse(res, 400, "invalid_request");
    return undefined;
  }
  return { link: verified.payload, body: request.body as Record<string, unknown> };
}

/** True when `body` has only the `allowed` keys and every `required` one. */
function hasExactKeys(body: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(body);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

/** Logs that a route failed, by route name only: never the error (it could carry provider or request text). */
function internalError(res: ServerResponse, route: "start" | "complete"): void {
  log.warn({ route }, "oauth loopback route failed");
  refuse(res, 500, "internal_error");
}

export async function handleOAuthLoopbackStart(
  request: OAuthLoopbackRequest,
  res: ServerResponse,
  deps: OAuthLoopbackRouteDeps,
): Promise<void> {
  const admitted = await admit(request, res, deps);
  if (!admitted) return;
  const { link, body } = admitted;
  if (!hasExactKeys(body, ["redirectUri"]) || typeof body.redirectUri !== "string") {
    refuse(res, 400, "invalid_request");
    return;
  }
  if (!isOAuthLoopbackRedirectUri(body.redirectUri)) {
    refuse(res, 400, "redirect_uri_invalid");
    return;
  }
  let started: { authorizeUrl: string; expiresAt: Date };
  try {
    started = await startOAuthSecretConnect({
      db: deps.db,
      cipher: deps.cipher,
      ownerId: link.principalId,
      name: link.name,
      resource: link.resource,
      ...(link.scope ? { scope: link.scope } : {}),
      ...(link.clientId ? { clientId: link.clientId } : {}),
      redirectUri: body.redirectUri,
      callback: "loopback",
      ...(deps.options ? { options: deps.options } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now() } : {}),
    });
  } catch (err) {
    // create_secret's own mapping: a fixed code and a fixed message, never the error's text.
    const described = describeOAuthSecretError(err);
    if (described) send(res, described.status, { error: described.code, message: described.message });
    else internalError(res, "start");
    return;
  }
  send(res, 200, { authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt.toISOString() });
}

export async function handleOAuthLoopbackComplete(
  request: OAuthLoopbackRequest,
  res: ServerResponse,
  deps: OAuthLoopbackRouteDeps,
): Promise<void> {
  const admitted = await admit(request, res, deps);
  if (!admitted) return;
  const { link, body } = admitted;
  if (
    !hasExactKeys(body, ["code", "state"], ["iss"]) ||
    !boundedString(body.code, 1, CODE_STATE_MAX_LENGTH) ||
    !boundedString(body.state, 1, CODE_STATE_MAX_LENGTH) ||
    (body.iss !== undefined && !boundedString(body.iss, 0, OAUTH_ISS_MAX_LENGTH))
  ) {
    refuse(res, 400, "invalid_request");
    return;
  }
  const adapter = oauthSecretAdapter(deps.cipher, deps.options, deps.fetchImpl) as OAuthLinkAdapter<unknown, unknown>;
  let outcome;
  try {
    outcome = await completeOAuthCallback({
      db: deps.db,
      adapters: new Map([[OAUTH_SECRET_PURPOSE, adapter]]),
      cipher: deps.cipher,
      state: body.state,
      code: body.code,
      ...(body.iss !== undefined ? { iss: body.iss } : {}),
      // Never used: `accept` admits only a request whose context holds its own loopback URI, which wins.
      redirectUri: "",
      // Only a loopback-started request (LB-3): the web callback refuses these, this route the rest.
      callbackKind: "loopback",
      // Checked before the state is consumed: anyone else's request is "invalid" and left untouched.
      accept: (r) => {
        if (r.principalId !== link.principalId || r.purpose !== OAUTH_SECRET_PURPOSE) return false;
        const context = parseOAuthSecretContext(r.context);
        return (
          context !== undefined &&
          context.ownerId === link.principalId &&
          context.name === link.name &&
          context.callback === "loopback" &&
          isOAuthLoopbackRedirectUri(context.redirectUri)
        );
      },
      ...(deps.now ? { now: deps.now() } : {}),
    });
  } catch {
    internalError(res, "complete");
    return;
  }
  if (outcome.kind === "invalid") {
    refuse(res, 400, "invalid");
    return;
  }
  if (outcome.kind === "failed") {
    refuse(res, 502, "failed");
    return;
  }
  send(res, 200, { confirmationCode: outcome.code });
}

/**
 * The two routes for the stdio link host: Bearer routes (the host hands them the Authorization
 * token, never the `t` query parameter) that read and bound their own body, as the HTTP transport
 * does for its routes.
 */
export function oauthLoopbackStdioRoutes(deps: OAuthLoopbackRouteDeps): Record<string, StdioBearerRoute> {
  const route =
    (handle: typeof handleOAuthLoopbackStart): StdioBearerRoute["bearer"] =>
    async (req: IncomingMessage, res: ServerResponse, token: string | null) => {
      let body: unknown;
      try {
        const raw = await readBody(req, OAUTH_LOOPBACK_BODY_LIMIT, AbortSignal.timeout(HTTP_LIMITS.requestMs));
        body = raw === "" ? undefined : parseBody(raw, req.headers["content-type"]);
      } catch (err) {
        if (!(err instanceof HttpBoundaryError)) throw err;
        // The body may be partly unread: answer, then close the connection.
        req.resume();
        send(res, err.status, { error: err.message }, { connection: "close" });
        return;
      }
      await handle({ method: req.method, token, body }, res, deps);
    };
  return {
    [OAUTH_LOOPBACK_START_PATH]: { bearer: route(handleOAuthLoopbackStart) },
    [OAUTH_LOOPBACK_COMPLETE_PATH]: { bearer: route(handleOAuthLoopbackComplete) },
  };
}
