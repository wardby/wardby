import { createServer, type ServerResponse } from "node:http";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { HTTP_LIMITS, HttpBoundaryError, readBody } from "../../mcp/transport/http-limits.js";
import { logger } from "../../core/logger.js";
import { CodingProxyError, PROXY_MAX_BODY_BYTES, type CodingProxy, type ProxyResponseSink } from "./proxy.js";
import type { RegistryService } from "./registry/service.js";
import type { ProxyProtocol } from "./types.js";

const proxyLog = logger.child({ module: "coding-proxy" });

export interface CodingProxyServerConfig {
  host: string;
  port: number;
  expectedHost?: string;
  registry?: Pick<RegistryService, "handle">;
  onRequest?: (event: { protocol: ProxyProtocol | "other"; status: number; durationMs: number }) => void;
}

export interface CodingProxyServerHandle {
  port: number;
  close(): Promise<void>;
}

function sendError(response: ServerResponse, status: number, code: string): void {
  response
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
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
  const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: true }, (request, response) => {
    const startedAt = performance.now();
    const protocol = routeProtocol(request.method, request.url) ?? "other";
    response.once("finish", () => {
      try {
        config.onRequest?.({ protocol, status: response.statusCode, durationMs: performance.now() - startedAt });
      } catch (error) {
        proxyLog.warn({ event: "metrics.observe_failed", err: error }, "coding proxy metrics observer failed");
      }
    });
    void (async () => {
      if (config.expectedHost && request.headers.host !== config.expectedHost) {
        sendError(response, 403, "invalid_host");
        return;
      }
      if (request.url?.startsWith("/registry/")) {
        if (!config.registry) {
          sendError(response, 404, "not_found");
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendError(response, 405, "method_not_allowed");
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
      const capability =
        protocol === "anthropic-messages"
          ? request.headers.authorization === undefined && typeof apiKeyHeader === "string"
            ? apiKeyHeader
            : ""
          : apiKeyHeader === undefined
            ? bearer(request.headers.authorization)
            : "";
      await proxy.execute(
        {
          bearer: capability,
          protocol,
          rawBody,
          requestKey: Array.isArray(requestKeyHeader) ? undefined : requestKeyHeader,
          anthropicBeta: Array.isArray(anthropicBetaHeader) ? "" : anthropicBetaHeader,
        },
        responseSink(response),
      );
    })().catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
        return;
      }
      if (error instanceof CodingProxyError || error instanceof HttpBoundaryError) {
        proxyLog.info(
          { event: "request.rejected", code: error instanceof CodingProxyError ? error.code : error.message },
          "coding proxy request rejected",
        );
        sendError(response, error.status, error instanceof CodingProxyError ? error.code : error.message);
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
  server.requestTimeout = HTTP_LIMITS.requestMs;
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
