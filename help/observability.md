---
id: observability
title: Monitor Wardby
summary: Scrape private Prometheus metrics from the coding proxy and the control plane, use the run.finished log for per-agent spend, and build production alerting.
audience: operator
tags: [observability, prometheus, grafana, metrics, logs, run.finished, spend, operations]
appliesTo: >=0.2.1
---

# Monitor Wardby

When `METRICS_BIND` is configured, two Wardby processes expose Prometheus
metrics at `/metrics`; scrape both. Keep each endpoint on a private network and
permit only your collector to scrape it.

- The coding proxy reports `wardby_proxy_*`: proxy requests, errors, latency,
  audit events such as rejected requests, model cost, reserved budget, and
  request leases (`wardby_proxy_leases_swept_total`,
  `wardby_proxy_lease_errors_total`; see
  `troubleshooting/stopped-proxy-holds`).
- The control plane (`wardby serve`) reports `wardby_coding_*`: coding-run
  outcomes such as `budget_exhausted`, active jobs, cleanup failures, run
  budget, and run duration. It also reports `wardby_run_follow_up*`: the
  chores queued after a run ends (`wardby_run_follow_ups_total`,
  `wardby_run_follow_ups_pending`, `wardby_run_follow_up_oldest_age_seconds`).
  Only the scheduler leader reports the backlog, so aggregate with `max`.
- Both report Node.js process health (`wardby_nodejs_*`).

Each endpoint also lists the other process's metric names as zeros, so collect
each family from the process that owns it. Metrics intentionally exclude
prompts, repository content, credentials, diffs, raw worker output, and run
identifiers.

With the Helm chart, set `codingProxy.metrics.enabled: true` and
`controlPlane.metrics.enabled: true`, and list your collector under each one's
`ingressFrom`; see [Install Wardby with Helm](install-helm.md).

For a local dashboard stack, run:

```sh
npm run observability:up
npm run observability:smoke
```

This starts Prometheus and Grafana locally. Use `npm run observability:down`
when finished.

In production, configure your own Prometheus-compatible collector, retention,
private connectivity, alerts, and SLOs. GCP operators can use the Ops Agent or
Managed Service for Prometheus; AWS operators can use the CloudWatch Agent
Prometheus collector. Wardby's reference cloud deployments do not provision
them, and MCP request metrics are not yet exported.

For spend per agent and for following one run, use the logs: metrics carry no
run or agent identifiers. The control plane writes one `run.finished` JSON line
per run, native or coding, with `runId`, `agentId`, `agentName`, `status`,
`costUsd`, `budgetUsd`, tokens, duration, and the budget limit that refused it
(`budgetLimit`), if any. Filter by `runId` to see that run's `coding.<stage>`
lifecycle lines and the coding proxy's `audit.<type>` lines. Ship the control
plane's and proxy's logs, never run pods' logs.

Alert on proxy failures, budget cutoffs, cleanup failures, stalled runs, and
sustained latency or memory growth. Wardby's database remains the source of
truth for runs, budgets, and accounting.

With the durable executor (`EXECUTOR=dbos`), also watch the server logs for
the `run_ownership_lost` warning. It means a run's owner stalled long enough
for another process to adopt the run, and the stalled attempt stopped without
writing the run; the step it stopped at had its model spend discarded. The run
itself is unaffected. Repeated warnings point at event-loop or database-pool
starvation. See the durable executor section of
[`docs/security-deployment.md`](../docs/security-deployment.md).

Read [`docs/observability.md`](../docs/observability.md) for configuration and
the full production checklist.
