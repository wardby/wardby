import { createServer, type ServerResponse } from "node:http";
import { HTTP_LIMITS, HttpBoundaryError, readBody } from "../../mcp/transport/http-limits.js";
import { logger } from "../../core/logger.js";
import { CodingProxyError, PROXY_MAX_BODY_BYTES, type CodingProxy, type ProxyResponseSink } from "./proxy.js";

const proxyLog = logger.child({ module: "coding-proxy" });

export interface CodingProxyServerConfig {
  host: string;
  port: number;
  expectedHost?: string;
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
    void (async () => {
      if (config.expectedHost && request.headers.host !== config.expectedHost) {
        sendError(response, 403, "invalid_host");
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
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
      const requestKeyHeader = request.headers["idempotency-key"] ?? request.headers["x-client-request-id"];
      await proxy.execute(
        {
          bearer: bearer(request.headers.authorization),
          rawBody,
          requestKey: Array.isArray(requestKeyHeader) ? undefined : requestKeyHeader,
        },
        responseSink(response),
      );
    })().catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
        return;
      }
      if (error instanceof CodingProxyError || error instanceof HttpBoundaryError) {
        sendError(response, error.status, error instanceof CodingProxyError ? error.code : error.message);
        return;
      }
      proxyLog.error({ event: "request.failed" }, "coding proxy request failed");
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
