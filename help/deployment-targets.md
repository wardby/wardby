---
id: deployment-targets
title: Choose a deployment target
summary: Compare local, self-hosted, and GKE deployment paths and their operational boundaries.
audience: operator
tags: [deployment, docker, gke, aws, production]
appliesTo: >=0.2.1
---

# Choose a deployment target

Wardby has a local development path, a self-hosted container deployment
reference, and a supported GKE reference deployment. The references provide
different parts of a production environment; operators must complete the
remaining controls and verification before accepting production work.

- **Local development:** `wardby quickstart` runs the control plane locally
  with its portable PostgreSQL container. It is the best place to evaluate,
  develop agents, and connect a local Codex or Claude Code client.
  `deploy/kind-coding` is a local Kubernetes proof harness, not a production
  deployment.
- **Self-hosted container deployment** (e.g., Docker Compose on a VM or
  on-premises host): Wardby supplies runtime and migration images plus a
  Compose/Caddy edge reference. The operator supplies PostgreSQL, secrets,
  network and egress controls, backups and restore testing, monitoring, and a
  separate coding-controller host. Configure authentication for the deployment.
- **Google Kubernetes Engine Autopilot:** the supported Google Cloud path. It
  provisions GKE, private-IP Cloud SQL with backups and point-in-time recovery,
  Artifact Registry, isolated Codex and Claude Code workers, HTTPS Gateway, and
  GCP-native secret and network controls. Operators still need to choose
  availability, test recovery, and configure alerts and retention. See
  [Deploy on GKE](deploy-gke.md).

AWS can run the portable runtime and has a Bedrock Claude adapter, but a native
AWS deployment module is planned and has not shipped. Other cloud providers
can run the production container image with equivalent database, ingress,
identity, secret, isolation, and observability controls; that infrastructure is
operator-owned.

The older `deploy/gcp` Cloud Run module is deprecated. Do not choose it for a
new installation.

Before going live, complete the release verification and security deployment
checks, and make plans for backups, upgrades, alerts, and incident response. Read
[`docs/getting-started.md`](../docs/getting-started.md) for the local and
container setup, and [`docs/security-deployment.md`](../docs/security-deployment.md)
for the production controls.
