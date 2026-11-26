# Observability

Two Wardby processes expose Prometheus metrics at `/metrics` when
`METRICS_BIND` is configured. Collection is pull-based. Keep each endpoint on a
private network and allow only the selected collector to reach it. Scrape both:
each covers signals the other cannot see.

| Process                        | Metrics                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coding proxy                   | `wardby_proxy_*`: requests by protocol and status class, latency, audit events (including rejected requests), model cost, reserved budget, token usage, and request leases                                                              |
| Control plane (`wardby serve`) | `wardby_coding_*`: coding-run lifecycle stages, terminal outcomes (including `budget_exhausted`), active jobs, cleanup failures, reserved and actual run budget, run duration; `wardby_run_follow_up*`: chores queued after a run ended |
| Both                           | `wardby_nodejs_*`: Node.js process health                                                                                                                                                                                               |

Every endpoint registers all `wardby_*` metric names, and exports every label
value (each run outcome, lifecycle stage, audit event, status class) as 0 from
start-up, so a series reads 0 rather than missing until its first event,
including right after a restart. A process therefore reports the other's
series as zeros. Collect `wardby_proxy_*` from the coding
proxy and `wardby_coding_*` from the control plane, or aggregate by process, so
those zeros do not hide the real values.

Labels are deliberately bounded and exclude prompts, repository content,
credentials, diffs, request bodies, raw worker output, and run identifiers.

With the Helm chart, set `codingProxy.metrics.enabled` and
`controlPlane.metrics.enabled`, and name your collector in each one's
`ingressFrom`; see "Metrics and pod annotations" in
[Install with Helm](install-helm.md).

## Request leases

A coding proxy that stops mid-request leaves the request's budget hold
unsettled until another proxy settles it (see
[Availability](availability.md#a-model-request-whose-proxy-stops-mid-stream)).
Two counters show it:

- `wardby_proxy_leases_swept_total{estimate="yes|no"}`: requests settled
  because their proxy stopped renewing the lease. A sustained rate means proxy
  processes are stopping mid-request; alert on a count over an hour that suits
  your fleet. `estimate="no"` means no estimate could be made, so that request
  keeps its full hold: alert on any.
- `wardby_proxy_lease_errors_total{stage="renew|sweep"}`: failed lease
  renewals and sweeps, including ones abandoned because they ran past twice
  their interval (a hung database query). A failing renewal lets other proxies
  settle live requests.

A worker's retry that takes over a stopped proxy's request is counted in
`wardby_proxy_audit_events_total{event="request.taken_over"}`; refusals of
retries appear as `request.rejected` events (see
[Availability](availability.md#a-retry-after-the-proxy-stopped-or-the-provider-refused)).

## Run follow-ups

When a run ends, the control plane records the chores that follow it (stopping
child runs, notifications, a pull request comment) in the database in the same
transaction as the run's final status. The scheduler leader then runs them, so
a control-plane restart between the status and the chores does not lose them: the
next leader sweep does them. A chore that fails is retried with a growing delay
(5 seconds, doubling to 10 minutes) and never holds up the others. Chores run
at least once, so each one is written to be safe to repeat.

A coding run's chores are left to the copy that ended the run for about a minute, so
a brief backlog of them is normal; one that outlives the minute means that copy died
or a chore keeps failing.

- `wardby_run_follow_ups_total{outcome="done|failed"}`: chores the leader
  finished or failed. A failure is retried, so a steady `failed` rate with a
  growing backlog means a chore keeps failing.
- `wardby_run_follow_ups_pending`: chores not yet done, as of the leader's last
  sweep.
- `wardby_run_follow_up_oldest_age_seconds`: how long the oldest chore not yet
  done has been waiting. Alert when it stays above a few minutes.

Only the replica holding the scheduler lease sweeps, so only it reports the
backlog gauges; the others report 0. Aggregate them with `max`, not `sum` or
`avg`. The log line `run_follow_up.failed` names the chore's `kind`, `runId`,
attempt and error name; never the error's message.

## Run logs

Metrics carry no run or agent identifiers, so per-agent and per-run questions
(which agent spent what, why one run stopped) are answered from the JSON logs
on stderr instead. Ship the control plane's and coding proxy's logs to your log
platform; never ship run pods' logs, which carry untrusted worker output.

| Line (`event`)   | Process       | What it records                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.finished`   | Control plane | One line per run, native or coding, when it ends: `runId`, `agentId`, `agentName`, `runKind`, `parentRunId`, `trigger`, `status`, `costUsd`, `budgetUsd`, `tokensIn`, `tokensOut`, `durationMs`, plus `budgetGroup` when the agent has one and `budgetLimit` (`run`, `run-tree`, `day`, `week`, `month`) when a budget refused it |
| `coding.<stage>` | Control plane | A coding run's lifecycle stages, by `runId`                                                                                                                                                                                                                                                                                       |
| `audit.<type>`   | Coding proxy  | Each model request of a coding run, by `runId`: reservations, refusals with their `reason`, and completed replies with `model`, `costUsd` and token counts                                                                                                                                                                        |

These lines hold identifiers, names, enumerated values, and amounts only; never
a run's task, final text, or error text. `run.finished` is written once per
run, by whichever process made the run terminal, so summing its `costUsd` by
`agentName` gives spend per agent. Start from an agent's `run.finished` lines
to find its `runId`s, then filter every line by `runId` to follow one run.

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
SLOs for their environment. MCP request metrics are not yet exported, so verify
required signals before production use.

## Production checklist

- Keep `/metrics` private; never expose it directly to the internet.
- Set retention intentionally in the Prometheus-compatible backend.
- Alert on request failures, budget cutoffs, cleanup failures, stalled runs,
  and sustained latency or memory growth.
- Confirm alerts reach an owned channel and rehearse one response path.
- Watch the logs for package audit mode: the control plane logs
  `coding.package_audit.set` when an owner turns it on, off or extends it, and
  the coding proxy logs `registry.audited` for each package it installs
  because of it (see [Package audit mode](coding-packages.md#package-audit-mode)).
- Treat telemetry as operational evidence, not as a replacement for Wardby's
  accounting database.
