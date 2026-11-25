import { afterEach, describe, expect, it } from "vitest";
import { startMetricsServer, type MetricsServerHandle } from "./metrics-server.js";
import { WardbyMetrics } from "./metrics.js";

describe("Prometheus metrics", () => {
  let server: MetricsServerHandle | undefined;

  afterEach(async () => server?.close());

  it("exports every bounded label combination as 0 before any event, so a restart reads 0, not no data", async () => {
    const text = await new WardbyMetrics().registry.metrics();
    for (const line of [
      'wardby_coding_runs_terminal_total{outcome="budget_exhausted"} 0',
      'wardby_coding_lifecycle_events_total{stage="terminal"} 0',
      'wardby_proxy_audit_events_total{event="request.rejected"} 0',
      'wardby_proxy_http_requests_total{protocol="anthropic-messages",status_class="5xx"} 0',
      'wardby_proxy_http_request_duration_seconds_count{protocol="openai-responses",status_class="2xx"} 0',
      'wardby_proxy_http_requests_total{protocol="tunnel",status_class="4xx"} 0',
      'wardby_proxy_tokens_total{kind="cached_input"} 0',
      'wardby_proxy_lease_errors_total{stage="sweep"} 0',
      'wardby_run_follow_ups_total{outcome="failed"} 0',
      "wardby_run_follow_ups_pending 0",
    ]) {
      expect(text).toContain(line);
    }
  });

  it("exports bounded lifecycle and proxy metrics without source or credential data", async () => {
    const metrics = new WardbyMetrics();
    metrics.emit({ stage: "launched", runId: "run-sensitive", jobId: "job-sensitive", budgetReservedUsd: 0.5 });
    metrics.emit({ stage: "terminal", runId: "run-sensitive", outcome: "succeeded", durationMs: 1_200 });
    metrics.emit({ stage: "cleanup", runId: "run-sensitive", cleanupSucceeded: false, budgetActualUsd: 0.2 });
    metrics.observeProxyAudit({
      type: "request.reserved",
      runId: "run-sensitive",
      requestId: "request-sensitive",
      model: "private-model-name",
      reservationUsd: 0.3,
    });
    // The completed reply repeats its hold; the reserved total counts it once.
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
    // A refused hold was never reserved.
    metrics.observeProxyAudit({
      type: "request.rejected",
      runId: "run-sensitive",
      model: "private-model-name",
      reason: "budget_exhausted",
      reservationUsd: 5,
    });
    metrics.observeProxyRequest({ protocol: "openai-responses", status: 403, durationMs: 250 });
    metrics.observeProxyRequest({ protocol: "tunnel", status: 407, durationMs: 3 });

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('wardby_proxy_http_requests_total{protocol="tunnel",status_class="4xx"} 1');
    expect(exposition).toContain('wardby_coding_lifecycle_events_total{stage="launched"} 1');
    expect(exposition).toContain('wardby_coding_runs_terminal_total{outcome="succeeded"} 1');
    expect(exposition).toContain("wardby_coding_active_jobs 0");
    expect(exposition).toContain("wardby_coding_cleanup_failures_total 1");
    expect(exposition).toContain('wardby_proxy_http_requests_total{protocol="openai-responses",status_class="4xx"} 1');
    expect(exposition).toContain("wardby_proxy_budget_reserved_usd_total 0.3");
    expect(exposition).toContain("wardby_proxy_cost_usd_total 0.2");
    expect(exposition).toContain('wardby_proxy_tokens_total{kind="input"} 10');
    expect(exposition).not.toContain("run-sensitive");
    expect(exposition).not.toContain("job-sensitive");
    expect(exposition).not.toContain("request-sensitive");
    expect(exposition).not.toContain("private-model-name");
  });

  it("counts swept leases by whether an estimate was booked, and lease errors by stage", async () => {
    const metrics = new WardbyMetrics();
    metrics.observeProxyAudit({
      type: "request.uncertain",
      runId: "run-sensitive",
      requestId: "request-sensitive",
      reason: "lease_expired",
      estimatedCostUsd: 0.01,
    });
    metrics.observeProxyAudit({ type: "request.uncertain", runId: "run-sensitive", reason: "lease_expired" });
    // An uncertain request with another reason is not a sweep.
    metrics.observeProxyAudit({ type: "request.uncertain", runId: "run-sensitive", reason: "upstream_transport" });
    metrics.observeProxyLeaseError("renew");
    metrics.observeProxyLeaseError("sweep");
    metrics.observeProxyLeaseError("sweep");

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('wardby_proxy_leases_swept_total{estimate="yes"} 1');
    expect(exposition).toContain('wardby_proxy_leases_swept_total{estimate="no"} 1');
    expect(exposition).toContain('wardby_proxy_lease_errors_total{stage="renew"} 1');
    expect(exposition).toContain('wardby_proxy_lease_errors_total{stage="sweep"} 2');
    expect(exposition).not.toContain("run-sensitive");
    expect(exposition).not.toContain("request-sensitive");
  });

  it("counts run follow-ups by outcome and reports the leader's backlog", async () => {
    const metrics = new WardbyMetrics();
    metrics.runFollowUpResult("done");
    metrics.runFollowUpResult("failed");
    metrics.runFollowUpResult("failed");
    metrics.runFollowUpBacklog({ pending: 4, oldestAgeSeconds: 90 });

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('wardby_run_follow_ups_total{outcome="done"} 1');
    expect(exposition).toContain('wardby_run_follow_ups_total{outcome="failed"} 2');
    expect(exposition).toContain("wardby_run_follow_ups_pending 4");
    expect(exposition).toContain("wardby_run_follow_up_oldest_age_seconds 90");
  });

  it("serves only health and Prometheus exposition endpoints", async () => {
    const metrics = new WardbyMetrics();
    server = await startMetricsServer(metrics.registry, { host: "127.0.0.1", port: 0 });

    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok\n");

    const scrape = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get("content-type")).toContain("text/plain");
    expect(await scrape.text()).toContain("wardby_nodejs_process_resident_memory_bytes");

    expect((await fetch(`http://127.0.0.1:${server.port}/metrics`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${server.port}/not-a-route`)).status).toBe(404);
  });
});
