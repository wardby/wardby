import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { HTTP_LIMITS, HttpBoundaryError, readBody } from "../../mcp/transport/http-limits.js";
import { logger } from "../../core/logger.js";
import type { ProxyAuditEvent } from "./types.js";
import { CodingProxyError, PROXY_MAX_BODY_BYTES, type CodingProxy, type ProxyResponseSink } from "./proxy.js";
import { RegistryError } from "../../coding/registry/types.js";
import {
  MAX_ORIGINS_BODY_BYTES,
  MAX_PLAN_BODY_BYTES,
  type RegistryResponse,
  type RegistryService,
} from "./registry/service.js";
import type { DependencyCacheService } from "./dependency-cache/service.js";
import type { ProxyProtocol } from "./types.js";
import { MCP_ROUTE_PATH } from "./mcp-route.js";

/** The worker's workflow-progress route (#582) and its body bound. */
export const WORKFLOW_PROGRESS_PATH = "/wardby/workflow-progress";
const WORKFLOW_PROGRESS_MAX_BYTES = 1024 * 1024;
import { SUBSTRATE_UPLOAD_MS } from "./substrate/routes.js";

const proxyLog = logger.child({ module: "coding-proxy" });

/**
 * Writes a proxy audit event to the operator log. The events carry ids,
 * models, amounts, statuses and fixed reason codes only, never request or
 * response content. `sink` defaults to the proxy's own logger.
 */
export function logProxyAudit(event: ProxyAuditEvent, sink: Pick<typeof proxyLog, "info"> = proxyLog): void {
  const { type, ...fields } = event;
  sink.info({ ...fields, event: `audit.${type}` }, "coding proxy audit");
}

export interface CodingProxyServerConfig {
  host: string;
  port: number;
  /** Exact `Host` values accepted (DNS-rebinding guard); absent means no check. */
  expectedHosts?: string[];
  registry?: Pick<RegistryService, "handle"> & Partial<Pick<RegistryService, "plan" | "refusals" | "origins">>;
  /** The dependency cache (`/cache/...`); absent when the deployment has it off. */
  dependencyCache?: Pick<DependencyCacheService, "handle" | "uploadMs">;
  /** Time to receive a whole request (default HTTP_LIMITS.requestMs); a cache upload gets its upload window instead. */
  requestMs?: number;
  /** The worker's MCP route (`/mcp`, createMcpRoute); absent, /mcp is not found. */
  mcp?: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  /**
   * The Substrate relay and transfer routes (`/substrate/...`, createSubstrateRoutes); absent, they are not found.
   * An authenticated upload calls `clearBodyTimer`, which lifts the per-request body timer for it.
   */
  substrate?: (request: IncomingMessage, response: ServerResponse, clearBodyTimer: () => void) => Promise<void>;
  /** Time an authenticated Substrate upload has to arrive (default SUBSTRATE_UPLOAD_MS). */
  substrateUploadMs?: number;
  onRequest?: (event: { protocol: ProxyProtocol | "other"; status: number; durationMs: number }) => void;
}

export interface CodingProxyServerHandle {
  port: number;
  close(): Promise<void>;
}

function sendError(response: ServerResponse, status: number, code: string, retryAfterSeconds?: number): void {
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(retryAfterSeconds !== undefined ? { "retry-after": String(retryAfterSeconds) } : {}),
    })
    .end(JSON.stringify({ error: { type: code, message: code } }));
}

function bearer(value: string | undefined): string {
  if (!value?.startsWith("Bearer ") || value.indexOf(" ", 7) !== -1) return "";
  return value.slice(7);
}

/** The registry's own auth: a registry-only token (`rrg_…`) carried as either
 *  a bearer token or the password half of HTTP basic auth (some clients,
 *  e.g. pip, only support basic auth for a package index). */
function registryToken(authorization: string | undefined): string {
  if (!authorization) return "";
  const bearerToken = bearer(authorization);
  if (bearerToken) return bearerToken;
  const basic = authorization.match(/^Basic ([A-Za-z0-9+/=]+)$/);
  if (!basic) return "";
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon >= 0 ? decoded.slice(colon + 1) : "";
}

/** Time a client has to upload a lockfile to the plan route. */
const PLAN_UPLOAD_MS = 60_000;

function sendRegistry(response: ServerResponse, result: RegistryResponse & { body: string }): void {
  response
    .writeHead(result.status, { "content-type": result.contentType, "cache-control": "no-store" })
    .end(result.body);
}

/** Time a client has to send the origins route's small request. */
const ORIGINS_UPLOAD_MS = 30_000;

interface BodyLimits {
  maxBytes: number;
  /** What the body is, for the 400 messages. */
  noun: string;
  tooLarge(): RegistryError;
}
const PLAN_BODY: BodyLimits = {
  maxBytes: MAX_PLAN_BODY_BYTES,
  noun: "lockfile",
  tooLarge: () => new RegistryError(413, "wardby_lockfile_too_large", "the lockfile is larger than 20 MiB"),
};
const ORIGINS_BODY: BodyLimits = {
  maxBytes: MAX_ORIGINS_BODY_BYTES,
  noun: "request",
  tooLarge: () => new RegistryError(413, "wardby_request_too_large", "the request is larger than 1 MiB"),
};

/** Reads a plan's lockfile (or the origins route's request) within its size
 *  limit, decoding each chunk as it arrives (no buffered copy of the raw
 *  bytes), and joins the text once. A RegistryError says why it could not be
 *  read. */
function readPlanBody(request: IncomingMessage, signal: AbortSignal, limits: BodyLimits = PLAN_BODY): Promise<string> {
  const tooLarge = () => limits.tooLarge();
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limits.maxBytes))
    return Promise.reject(tooLarge());
  const encoding = request.headers["content-encoding"];
  if (encoding && encoding !== "identity")
    return Promise.reject(
      new RegistryError(400, "wardby_bad_request", `the ${limits.noun} must not be content-encoded`),
    );
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const parts: string[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      request.off("aborted", failed);
      signal.removeEventListener("abort", failed);
    };
    const fail = (error: RegistryError) => {
      cleanup();
      parts.length = 0;
      request.pause();
      reject(error);
    };
    const failed = () => fail(new RegistryError(400, "wardby_bad_request", `the ${limits.noun} could not be read`));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.maxBytes) fail(tooLarge());
      else parts.push(decoder.write(chunk));
    };
    const end = () => {
      cleanup();
      parts.push(decoder.end());
      resolve(parts.join(""));
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    request.once("aborted", failed);
    signal.addEventListener("abort", failed, { once: true });
    if (signal.aborted) failed();
  });
}

/** An error answer to a request whose body was not read: close the
 *  connection rather than read (or keep) what the client is still sending. */
function closeIfBodyUnread(request: IncomingMessage, response: ServerResponse): void {
  if (!request.complete && !response.headersSent) response.setHeader("connection", "close");
}

function routeProtocol(method: string | undefined, url: string | undefined): ProxyProtocol | undefined {
  if (method !== "POST") return undefined;
  if (url === "/v1/responses") return "openai-responses";
  if (url === "/v1/messages" || url === "/v1/messages?beta=true") return "anthropic-messages";
  return undefined;
}

function responseSink(response: ServerResponse): ProxyResponseSink {
  return {
    start(status, headers) {
      if (!response.destroyed) response.writeHead(status, headers);
    },
    write(chunk) {
      if (response.destroyed) return Promise.reject(new Error("client_disconnected"));
      return new Promise<void>((resolve, reject) =>
        response.write(chunk, (error) => (error ? reject(error) : resolve())),
      );
    },
    end() {
      if (!response.destroyed) response.end();
    },
    destroy() {
      if (!response.destroyed) response.destroy();
    },
  };
}

export async function startCodingProxyServer(
  proxy: CodingProxy,
  config: CodingProxyServerConfig,
): Promise<CodingProxyServerHandle> {
  const requestMs = config.requestMs ?? HTTP_LIMITS.requestMs;
  // A snapshot upload (up to WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB) cannot
  // arrive within requestMs, and Node's requestTimeout is server-wide: with
  // the cache on it is widened to cover the upload window (which the cache
  // enforces on the upload itself), and every request gets a requestMs timer
  // of its own. Only the cache lifts that timer, and only for an upload it
  // has authenticated, found eligible and given its upload slot.
  const extendedRequests = config.dependencyCache !== undefined || config.substrate !== undefined;
  const uploadWindowMs = Math.max(
    config.dependencyCache?.uploadMs ?? 0,
    config.substrate ? (config.substrateUploadMs ?? SUBSTRATE_UPLOAD_MS) : 0,
  );
  const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: true }, (request, response) => {
    const startedAt = performance.now();
    const bodyTimer = extendedRequests
      ? setTimeout(() => {
          if (!request.complete) request.socket.destroy();
        }, requestMs).unref()
      : undefined;
    // Done with once the response is over (finished or closed early).
    if (bodyTimer) response.once("close", () => clearTimeout(bodyTimer));
    const protocol = routeProtocol(request.method, request.url) ?? "other";
    response.once("finish", () => {
      try {
        config.onRequest?.({ protocol, status: response.statusCode, durationMs: performance.now() - startedAt });
      } catch (error) {
        proxyLog.warn({ event: "metrics.observe_failed", err: error }, "coding proxy metrics observer failed");
      }
    });
    void (async () => {
      if (config.expectedHosts && !config.expectedHosts.includes(request.headers.host ?? "")) {
        closeIfBodyUnread(request, response);
        sendError(response, 403, "invalid_host");
        return;
      }
      // The registry builds its URLs on this host, so only a value the guard
      // above matched exactly is ever passed (never X-Forwarded-*); with no
      // guard configured the registry keeps its own fixed base.
      const validatedHost = config.expectedHosts ? request.headers.host : undefined;
      if (request.url?.startsWith("/cache/")) {
        if (!config.dependencyCache) {
          closeIfBodyUnread(request, response);
          sendError(response, 404, "not_found");
          return;
        }
        await config.dependencyCache.handle(request, response, registryToken(request.headers.authorization), () =>
          clearTimeout(bodyTimer),
        );
        return;
      }
      if (request.url?.startsWith("/substrate/")) {
        if (!config.substrate) {
          closeIfBodyUnread(request, response);
          sendError(response, 404, "not_found");
          return;
        }
        await config.substrate(request, response, () => clearTimeout(bodyTimer));
        return;
      }
      if (request.url?.startsWith("/registry/")) {
        if (!config.registry) {
          sendError(response, 404, "not_found");
          return;
        }
        const plan = request.url.match(/^\/registry\/([a-z0-9-]+)\/-\/plan(?:\?.*)?$/);
        if (plan && request.method === "POST" && config.registry.plan) {
          // Lockfile verification. The registry authenticates the token and
          // takes a plan slot before it asks for the body, which is then read
          // within its own size and time bounds.
          const controller = new AbortController();
          response.on("close", () => {
            if (!response.writableFinished) controller.abort();
          });
          let bodyRead = false;
          const result = await config.registry.plan({
            ecosystem: plan[1],
            token: registryToken(request.headers.authorization),
            ...(validatedHost ? { host: validatedHost } : {}),
            readBody: () => {
              bodyRead = true;
              return readPlanBody(request, AbortSignal.any([controller.signal, AbortSignal.timeout(PLAN_UPLOAD_MS)]));
            },
            signal: controller.signal,
          });
          // Refused before the body was read: close the connection rather
          // than read (or keep) what the client is still sending.
          if (!bodyRead) response.setHeader("connection", "close");
          if ("body" in result) sendRegistry(response, result);
          else {
            void result.stream.cancel().catch(() => undefined);
            sendError(response, 500, "internal_error");
          }
          return;
        }
        const origins = request.url.match(/^\/registry\/([a-z0-9-]+)\/-\/origins(?:\?.*)?$/);
        if (origins && request.method === "POST" && config.registry.origins) {
          // The real upstream address of each file a lockfile names. The token is authenticated before the (small)
          // body is read, within its own size and time bounds.
          const controller = new AbortController();
          response.on("close", () => {
            if (!response.writableFinished) controller.abort();
          });
          let bodyRead = false;
          const result = await config.registry.origins({
            ecosystem: origins[1],
            token: registryToken(request.headers.authorization),
            readBody: () => {
              bodyRead = true;
              return readPlanBody(
                request,
                AbortSignal.any([controller.signal, AbortSignal.timeout(ORIGINS_UPLOAD_MS)]),
                ORIGINS_BODY,
              );
            },
            signal: controller.signal,
          });
          if (!bodyRead) response.setHeader("connection", "close");
          if ("body" in result) sendRegistry(response, result);
          else {
            void result.stream.cancel().catch(() => undefined);
            sendError(response, 500, "internal_error");
          }
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        // The run's recent refusals, for clients that don't print the 403 body (pip, uv).
        const refusals = request.url.match(/^\/registry\/-\/refusals(?:\?(.*))?$/);
        if (refusals && config.registry.refusals) {
          const since = new URLSearchParams(refusals[1] ?? "").get("since");
          sendRegistry(
            response,
            await config.registry.refusals({
              token: registryToken(request.headers.authorization),
              ...(since ? { since: new Date(since) } : {}),
            }),
          );
          return;
        }
        const match = request.url.match(/^\/registry\/([a-z0-9-]+)\/(.*)$/);
        if (!match) {
          sendError(response, 404, "not_found");
          return;
        }
        const controller = new AbortController();
        response.on("close", () => controller.abort());
        const result = await config.registry.handle({
          method: request.method,
          ecosystem: match[1],
          subpath: match[2].split("?")[0],
          token: registryToken(request.headers.authorization),
          signal: controller.signal,
          ...(validatedHost ? { host: validatedHost } : {}),
        });
        response.statusCode = result.status;
        response.setHeader("content-type", result.contentType);
        if ("body" in result) {
          response.end(request.method === "HEAD" ? undefined : result.body);
          return;
        }
        if (request.method === "HEAD") {
          // The registry answers HEAD without starting a download; cancel
          // defensively anyway so a stream can never hold a reservation.
          void result.stream.cancel().catch(() => undefined);
          response.end();
          return;
        }
        // pipeline (not .pipe) destroys the source when the client
        // disconnects or the response errors, which cancels the web stream
        // so the registry releases the run's in-flight reservation.
        pipeline(Readable.fromWeb(result.stream as WebReadableStream), response, (error) => {
          if (error && !response.destroyed) response.destroy();
        });
        return;
      }
      if (request.url === MCP_ROUTE_PATH || request.url?.startsWith(`${MCP_ROUTE_PATH}?`)) {
        if (!config.mcp) {
          closeIfBodyUnread(request, response);
          sendError(response, 404, "not_found");
          return;
        }
        await config.mcp(request, response);
        return;
      }
      if (request.url === WORKFLOW_PROGRESS_PATH) {
        // A workflow run's phases and sub-agents (#582), from the worker, for the run's steps. The
        // capability is the run's (x-api-key, as on its model requests); the body is bounded.
        if (request.method !== "POST") {
          closeIfBodyUnread(request, response);
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          closeIfBodyUnread(request, response);
          sendError(response, 415, "unsupported_content_type");
          return;
        }
        const apiKey = request.headers["x-api-key"];
        const rawBody = await readBody(
          request,
          WORKFLOW_PROGRESS_MAX_BYTES,
          AbortSignal.timeout(HTTP_LIMITS.requestMs),
        );
        await proxy.workflowProgress(typeof apiKey === "string" ? apiKey : "", rawBody);
        response.writeHead(204, { "cache-control": "no-store" }).end();
        return;
      }
      if (request.method === "HEAD" && request.url === "/api/hello") {
        response.writeHead(200, { "cache-control": "no-store" }).end();
        return;
      }
      const protocol = routeProtocol(request.method, request.url);
      if (!protocol) {
        sendError(response, 404, "not_found");
        return;
      }
      if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        sendError(response, 415, "unsupported_content_type");
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_LIMITS.requestMs);
      let rawBody: string;
      try {
        rawBody = await readBody(request, PROXY_MAX_BODY_BYTES, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      // x-client-request-id is a tracing identifier that Codex may reuse across a multi-request tool loop.
      const requestKeyHeader = request.headers["idempotency-key"];
      const apiKeyHeader = request.headers["x-api-key"];
      const anthropicBetaHeader = request.headers["anthropic-beta"];
      // Claude Code's sub-agent id (#582): read only for a workflow session's steps, never forwarded.
      const agentIdHeader = request.headers["x-claude-code-agent-id"];
      // The capability travels in exactly one header. Claude sends x-api-key; Codex sends a Bearer,
      // except on Substrate, where the egress gateway injects the run's capability as X-Api-Key and
      // Codex (header mode, src/coding-worker/sdk.ts) sends no Authorization at all. A request with
      // both headers is refused on either route, whatever the Authorization holds.
      const authorization = request.headers.authorization;
      const capability =
        protocol === "anthropic-messages"
          ? authorization === undefined && typeof apiKeyHeader === "string"
            ? apiKeyHeader
            : ""
          : apiKeyHeader === undefined
            ? bearer(authorization)
            : authorization === undefined && typeof apiKeyHeader === "string"
              ? apiKeyHeader
              : "";
      await proxy.execute(
        {
          bearer: capability,
          protocol,
          rawBody,
          requestKey: Array.isArray(requestKeyHeader) ? undefined : requestKeyHeader,
          anthropicBeta: Array.isArray(anthropicBetaHeader) ? "" : anthropicBetaHeader,
          ...(typeof agentIdHeader === "string" ? { agentId: agentIdHeader } : {}),
        },
        responseSink(response),
      );
    })().catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
        return;
      }
      closeIfBodyUnread(request, response);
      if (error instanceof CodingProxyError || error instanceof HttpBoundaryError) {
        proxyLog.info(
          { event: "request.rejected", code: error instanceof CodingProxyError ? error.code : error.message },
          "coding proxy request rejected",
        );
        sendError(
          response,
          error.status,
          error instanceof CodingProxyError ? error.code : error.message,
          error instanceof CodingProxyError ? error.retryAfterSeconds : undefined,
        );
        return;
      }
      // The client (an untrusted worker) still gets only "internal_error";
      // the operator needs the reason. This log is control-plane side and the
      // serializer redacts token-shaped values -- without it an upstream
      // failure is indistinguishable from any other 500 (cost a live smoke
      // several blind runs).
      proxyLog.error({ event: "request.failed", err: error }, "coding proxy request failed");
      sendError(response, 500, "internal_error");
    });
  });
  server.requestTimeout = extendedRequests ? requestMs + uploadWindowMs : requestMs;
  server.headersTimeout = HTTP_LIMITS.headersMs;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : config.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
