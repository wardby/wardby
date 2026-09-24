# Documentation

- [Getting started](getting-started.md) runs Wardby locally from npm with
  containerized PostgreSQL and a budgeted sample agent.
- [Getting started on GKE](getting-started-gke.md) covers the supported Google
  Cloud deployment from project setup through verification and teardown.
- [Runtime architecture](architecture-runtime.md) explains the control-plane,
  provider, persistence, and execution boundaries.
- [Coding-agent setup](coding-agent-setup.md) configures the local trusted proxy
  and isolated Codex or Claude Code workers.
- [Coding-worker isolation](coding-worker-isolation.md) documents the threat
  model and enforced worker boundary.
- [Bring-your-own worker images](coding-worker-byo-images.md) explains how to
  extend the reviewed worker image contract.
- [Observability](observability.md) covers Prometheus metrics, Grafana, cloud
  collectors, retention, and production ownership.
- [Release verification](release-verification.md) lists the automated and live
  checks for a release candidate.
- [Security deployment](security-deployment.md) covers authentication, secrets,
  networking, migrations, recovery, and known limitations.

Historical implementation plans, dated evidence, and internal design records
are intentionally maintained outside the public repository.
