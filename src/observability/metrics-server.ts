import { createServer } from "node:http";
import type { Registry } from "@prometheus-io/client";

export interface MetricsServerConfig {
  host: string;
  port: number;
}

export interface MetricsServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Serve the Prometheus exposition endpoint on an explicitly private listener. */
export async function startMetricsServer(
  registry: Registry,
  config: MetricsServerConfig,
): Promise<MetricsServerHandle> {
  const server = createServer({ maxHeaderSize: 8 * 1024, requireHostHeader: false }, (request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/healthz") {
        response
          .writeHead(200, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" })
          .end("ok\n");
        return;
      }
      if (request.method === "GET" && request.url === "/metrics") {
        response
          .writeHead(200, { "cache-control": "no-store", "content-type": registry.contentType })
          .end(await registry.metrics());
        return;
      }
      response
        .writeHead(404, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" })
        .end("not found\n");
    })().catch(() => {
      if (!response.headersSent) {
        response
          .writeHead(500, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" })
          .end("internal error\n");
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
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
