# Observability

Wardby's coding proxy exposes Prometheus metrics at `/metrics` when
`METRICS_BIND` is configured. Collection is pull-based. Keep the endpoint on a
private network and allow only the selected collector to reach it.

Metrics cover proxy requests, errors, latency, audit events, model cost,
reserved budget, actual spend, coding-run outcomes, and Node.js process health.
Labels are deliberately bounded and exclude prompts, repository content,
credentials, diffs, request bodies, raw worker output, and run identifiers.

## Local Prometheus and Grafana

The included Compose profile provisions Prometheus, Grafana, and the Wardby
dashboards without making a paid model request:

```sh
npm run observability:up
npm run observability:smoke
npm run observability:down
```

Grafana is available at `http://127.0.0.1:3000` and Prometheus at
`http://127.0.0.1:9090`. The local Prometheus volume retains 24 hours of time
series. Grafana stores dashboard configuration, not the authoritative metrics
history. Wardby's database remains the source of truth for runs, budgets, and
accounting records.

## Cloud collectors

- AWS operators can configure the [CloudWatch Agent Prometheus
  collector](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-PrometheusEC2.html)
  on EC2, ECS, or EKS to scrape Wardby over private networking.
- GCP operators can use the [Google Cloud Ops Agent Prometheus
  receiver](https://cloud.google.com/stackdriver/docs/managed-prometheus/setup-opsagent)
  or a Managed Service for Prometheus collector.
- Any collector or hosted platform that accepts Prometheus exposition format
  can scrape the same endpoint.

The reference cloud deployments do not provision these collectors. Operators
must configure authentication, private reachability, retention, alerting, and
SLOs for their environment. Application/MCP coverage is still narrower than
the coding-proxy coverage, so verify required signals before production use.

## Production checklist

- Keep `/metrics` private; never expose it directly to the internet.
- Set retention intentionally in the Prometheus-compatible backend.
- Alert on request failures, budget cutoffs, cleanup failures, stalled runs,
  and sustained latency or memory growth.
- Confirm alerts reach an owned channel and rehearse one response path.
- Treat telemetry as operational evidence, not as a replacement for Wardby's
  accounting database.
