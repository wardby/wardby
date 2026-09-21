import "../env.js";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { loadMetricsConfig } from "../observability/config.js";
import { WardbyMetrics } from "../observability/metrics.js";
import { startMetricsServer, type MetricsServerHandle } from "../observability/metrics-server.js";
import { startConfiguredCodingProxy } from "../providers/coding-proxy/runtime.js";

const proxyLog = logger.child({ module: "coding-proxy-runtime" });

async function main(): Promise<void> {
  const metrics = new WardbyMetrics();
  const metricsConfig = loadMetricsConfig();
  const server = await startConfiguredCodingProxy({
    db: prisma,
    audit: metrics.observeProxyAudit,
    onRequest: (event) => metrics.observeProxyRequest(event),
  });
  let metricsServer: MetricsServerHandle | undefined;
  try {
    metricsServer = metricsConfig.bind ? await startMetricsServer(metrics.registry, metricsConfig.bind) : undefined;
  } catch (error) {
    await server.close();
    throw error;
  }
  proxyLog.info({ event: "proxy.started", port: server.port }, "coding proxy started");
  if (metricsServer) {
    proxyLog.info({ event: "metrics.started", port: metricsServer.port }, "private metrics server started");
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      proxyLog.info({ event: "proxy.stopping", signal }, "coding proxy stopping");
      await metricsServer?.close();
      await server.close();
      await prisma.$disconnect();
    })().catch((error: unknown) => {
      proxyLog.error({ event: "proxy.shutdown_failed", err: error }, "coding proxy shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(async (error: unknown) => {
  proxyLog.error({ event: "proxy.start_failed", err: error }, "coding proxy failed to start");
  await prisma.$disconnect();
  process.exitCode = 1;
});
