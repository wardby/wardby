import { afterEach, describe, expect, it } from "vitest";
import { startMetricsServer, type MetricsServerHandle } from "./metrics-server.js";
import { ReevoMetrics } from "./metrics.js";

describe("Prometheus metrics", () => {
  let server: MetricsServerHandle | undefined;

  afterEach(async () => server?.close());

  it("exports bounded lifecycle and proxy metrics without source or credential data", async () => {
    const metrics = new ReevoMetrics();
    metrics.emit({ stage: "launched", runId: "run-sensitive", jobId: "job-sensitive", budgetReservedUsd: 0.5 });
    metrics.emit({ stage: "terminal", runId: "run-sensitive", outcome: "succeeded", durationMs: 1_200 });
    metrics.emit({ stage: "cleanup", runId: "run-sensitive", cleanupSucceeded: false, budgetActualUsd: 0.2 });
    metrics.observeProxyAudit({
      type: "response.completed",
      runId: "run-sensitive",
      requestId: "request-sensitive",
      model: "private-model-name",
      reservationUsd: 0.3,
      costUsd: 0.2,
      inputTokens: 10,
      outputTokens: 20,
    });
    metrics.observeProxyRequest({ protocol: "openai-responses", status: 403, durationMs: 250 });

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('reevo_coding_lifecycle_events_total{stage="launched"} 1');
    expect(exposition).toContain('reevo_coding_runs_terminal_total{outcome="succeeded"} 1');
    expect(exposition).toContain("reevo_coding_active_jobs 0");
    expect(exposition).toContain("reevo_coding_cleanup_failures_total 1");
    expect(exposition).toContain('reevo_proxy_http_requests_total{protocol="openai-responses",status_class="4xx"} 1');
    expect(exposition).toContain("reevo_proxy_budget_reserved_usd_total 0.3");
    expect(exposition).toContain("reevo_proxy_cost_usd_total 0.2");
    expect(exposition).toContain('reevo_proxy_tokens_total{kind="input"} 10');
    expect(exposition).not.toContain("run-sensitive");
    expect(exposition).not.toContain("job-sensitive");
    expect(exposition).not.toContain("request-sensitive");
    expect(exposition).not.toContain("private-model-name");
  });

  it("serves only health and Prometheus exposition endpoints", async () => {
    const metrics = new ReevoMetrics();
    server = await startMetricsServer(metrics.registry, { host: "127.0.0.1", port: 0 });

    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok\n");

    const scrape = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get("content-type")).toContain("text/plain");
    expect(await scrape.text()).toContain("reevo_nodejs_process_resident_memory_bytes");

    expect((await fetch(`http://127.0.0.1:${server.port}/metrics`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${server.port}/not-a-route`)).status).toBe(404);
  });
});
