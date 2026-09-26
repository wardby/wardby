import "../env.js";
import { createPrismaClient } from "../core/db.js";
import { logger } from "../core/logger.js";
import { loadMetricsConfig } from "../observability/config.js";
import { WardbyMetrics } from "../observability/metrics.js";
import { startMetricsServer, type MetricsServerHandle } from "../observability/metrics-server.js";
import { startConfiguredCodingProxy } from "../providers/coding-proxy/runtime.js";

const proxyLog = logger.child({ module: "coding-proxy-runtime" });

/** Explicit pool sizes: the default (2 x CPUs + 1) is only 3 at the proxy's
 *  CPU request, and a lockfile install's concurrent registry queries used to
 *  take every connection, so the ledger transaction of a model request timed
 *  out and the run failed (job_coding_stream_failed). The two pools are
 *  separate so registry traffic can never starve the ledger. Keep their sum
 *  well inside the database's connection limit (a Cloud SQL db-f1-micro allows
 *  about 25, shared with the control plane). */
function poolMax(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
const prisma = createPrismaClient(process.env.DATABASE_URL, { poolMax: poolMax("CODING_PROXY_DB_POOL_MAX", 5) });
const registryPrisma = createPrismaClient(process.env.DATABASE_URL, {
  poolMax: poolMax("REGISTRY_DB_POOL_MAX", 3),
});

async function main(): Promise<void> {
  const metrics = new WardbyMetrics();
  const metricsConfig = loadMetricsConfig();
  const server = await startConfiguredCodingProxy({
    db: prisma,
    registryDb: registryPrisma,
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
      await Promise.all([prisma.$disconnect(), registryPrisma.$disconnect()]);
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
  await Promise.all([prisma.$disconnect(), registryPrisma.$disconnect()]);
  process.exitCode = 1;
});
