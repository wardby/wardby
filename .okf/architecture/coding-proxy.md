---
type: Architecture Pattern
title: Coding proxy
description: Sits between coding workers and the model providers - injects credentials, meters tokens and cost, and exposes metrics.
tags: [coding, proxy, metering, observability]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: arch-runtime
    resource: /docs/architecture-runtime.md
---

# Role

`wardby-coding-proxy` is the only egress for a [coding worker](/architecture/coding-workers.md).
It injects real credentials, meters tokens and cost, writes a usage ledger to
Postgres, and serves `/metrics` (port 9464, private network only) to
Prometheus and Grafana.[^arch-runtime] It also serves allowlisted package
installs (minimum release age, OSV audit, every package recorded).

# Cap at the boundary, reconcile after

The proxy writes its own ledger during a run. `wardby mcp` reconciles it into
the `Run` row when the container finishes. This is how the
[budget guardrail](/architecture/budget-guardrail.md) applies to opaque agent
runs.

Code: `src/providers/coding-proxy/`, `src/coding-proxy/main.ts`.

[^arch-runtime]: Runtime architecture guide
