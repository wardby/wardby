import { createServer, type ServerResponse } from "node:http";
import { HTTP_LIMITS, HttpBoundaryError, readBody } from "../../mcp/transport/http-limits.js";
import { logger } from "../../core/logger.js";
import { CodingProxyError, PROXY_MAX_BODY_BYTES, type CodingProxy, type ProxyResponseSink } from "./proxy.js";
import type { ProxyProtocol } from "./types.js";

const proxyLog = logger.child({ module: "coding-proxy" });

export interface CodingProxyServerConfig {
  host: string;
  port: number;
  expectedHost?: string;
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
