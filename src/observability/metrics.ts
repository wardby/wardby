import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import type { CodingLifecycleEvent, CodingRunObserver } from "../coding/observability.js";
import type { ProxyAuditEvent } from "../providers/coding-proxy/types.js";

type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";
type ProxyProtocolLabel = "openai-responses" | "anthropic-messages" | "other";

export interface ProxyHttpMetricEvent {
  protocol: ProxyProtocolLabel;
  status: number;
  durationMs: number;
}

function statusClass(status: number): StatusClass {
  if (status >= 100 && status < 200) return "1xx";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

/**
 * Prometheus adapter for the metadata-only lifecycle and proxy audit signals.
 * Labels are deliberately finite enums: run IDs, request IDs, models, reasons,
 * credentials, and untrusted input never enter the metrics registry.
 */
export class WardbyMetrics implements CodingRunObserver {
  readonly registry: Registry;
  private readonly lifecycleEvents: Counter<"stage">;
  private readonly terminalRuns: Counter<"outcome">;
  private readonly activeJobs: Gauge;
  private readonly cleanupFailures: Counter;
  private readonly budgetReserved: Counter;
  private readonly budgetActual: Counter;
  private readonly runDuration: Histogram;
  private readonly proxyAuditEvents: Counter<"event">;
  private readonly proxyRequests: Counter<"protocol" | "status_class">;
  private readonly proxyRequestDuration: Histogram<"protocol" | "status_class">;
  private readonly proxyBudgetReserved: Counter;
  private readonly proxyCost: Counter;
  private readonly proxyTokens: Counter<"kind">;
  private activeJobCount = 0;

  constructor(registry = new Registry()) {
    this.registry = registry;
    collectDefaultMetrics({ register: registry, prefix: "wardby_nodejs_" });

    this.lifecycleEvents = new Counter({
      name: "wardby_coding_lifecycle_events_total",
      help: "Coding lifecycle events by finite stage.",
      labelNames: ["stage"],
      registers: [registry],
    });
    this.terminalRuns = new Counter({
      name: "wardby_coding_runs_terminal_total",
      help: "Completed coding runs by terminal outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    });
    this.activeJobs = new Gauge({
      name: "wardby_coding_active_jobs",
      help: "Coding jobs launched by this process that have not completed cleanup.",
      registers: [registry],
    });
    this.cleanupFailures = new Counter({
      name: "wardby_coding_cleanup_failures_total",
      help: "Coding cleanup attempts that failed.",
      registers: [registry],
    });
    this.budgetReserved = new Counter({
      name: "wardby_coding_budget_reserved_usd_total",
      help: "USD budget reserved for coding runs.",
      registers: [registry],
    });
    this.budgetActual = new Counter({
      name: "wardby_coding_budget_actual_usd_total",
      help: "USD budget charged for coding runs.",
      registers: [registry],
    });
    this.runDuration = new Histogram({
      name: "wardby_coding_run_duration_seconds",
      help: "Observed coding run duration in seconds.",
      buckets: [1, 10, 30, 60, 300, 900, 1800, 3600],
      registers: [registry],
    });
    this.proxyAuditEvents = new Counter({
      name: "wardby_proxy_audit_events_total",
      help: "Trusted coding proxy audit events by finite event type.",
      labelNames: ["event"],
      registers: [registry],
    });
    this.proxyRequests = new Counter({
      name: "wardby_proxy_http_requests_total",
      help: "Coding proxy HTTP requests by protocol and status class.",
      labelNames: ["protocol", "status_class"],
      registers: [registry],
    });
    this.proxyRequestDuration = new Histogram({
      name: "wardby_proxy_http_request_duration_seconds",
      help: "Coding proxy HTTP request duration by protocol and status class.",
      labelNames: ["protocol", "status_class"],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
      registers: [registry],
    });
    this.proxyBudgetReserved = new Counter({
      name: "wardby_proxy_budget_reserved_usd_total",
      help: "USD budget reserved by trusted coding proxy requests.",
      registers: [registry],
    });
    this.proxyCost = new Counter({
      name: "wardby_proxy_cost_usd_total",
      help: "USD cost reported by completed upstream proxy responses.",
      registers: [registry],
    });
    this.proxyTokens = new Counter({
      name: "wardby_proxy_tokens_total",
      help: "Token usage reported by completed upstream proxy responses by token kind.",
      labelNames: ["kind"],
      registers: [registry],
    });
  }

  emit(event: CodingLifecycleEvent): void {
    this.lifecycleEvents.inc({ stage: event.stage });
    if (event.stage === "launched") {
      this.activeJobCount += 1;
      this.activeJobs.set(this.activeJobCount);
    }
    if (event.stage === "cleanup") {
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      this.activeJobs.set(this.activeJobCount);
      if (event.cleanupSucceeded === false) this.cleanupFailures.inc();
    }
    if (event.stage === "terminal" && event.outcome) this.terminalRuns.inc({ outcome: event.outcome });
    if (event.budgetReservedUsd !== undefined) this.budgetReserved.inc(event.budgetReservedUsd);
    if (event.budgetActualUsd !== undefined) this.budgetActual.inc(event.budgetActualUsd);
    if (event.durationMs !== undefined) this.runDuration.observe(event.durationMs / 1_000);
  }

  observeProxyAudit = (event: ProxyAuditEvent): void => {
    this.proxyAuditEvents.inc({ event: event.type });
    if (event.reservationUsd !== undefined) this.proxyBudgetReserved.inc(event.reservationUsd);
    if (event.type !== "response.completed") return;
    if (event.costUsd !== undefined) this.proxyCost.inc(event.costUsd);
    if (event.inputTokens !== undefined) this.proxyTokens.inc({ kind: "input" }, event.inputTokens);
    if (event.outputTokens !== undefined) this.proxyTokens.inc({ kind: "output" }, event.outputTokens);
    if (event.cachedInputTokens !== undefined) this.proxyTokens.inc({ kind: "cached_input" }, event.cachedInputTokens);
    if (event.cacheWriteTokens !== undefined) this.proxyTokens.inc({ kind: "cache_write" }, event.cacheWriteTokens);
    if (event.reasoningTokens !== undefined) this.proxyTokens.inc({ kind: "reasoning" }, event.reasoningTokens);
  };

  observeProxyRequest(event: ProxyHttpMetricEvent): void {
    const labels = { protocol: event.protocol, status_class: statusClass(event.status) };
    this.proxyRequests.inc(labels);
    this.proxyRequestDuration.observe(labels, event.durationMs / 1_000);
  }
}
