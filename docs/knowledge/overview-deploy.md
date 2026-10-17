---
type: overview
title: Deployment topology and infrastructure
description: Terraform, Compose and Kubernetes assets connect trusted services to isolated workers and durable storage.
tags: [deployment, infrastructure, isolation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:23:52.509Z }
sources:
  - id: compose
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/deploy/production/compose.yml#L34-L47
  - id: lifecycle
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/deploy/production/compose.yml#L71-L110
  - id: gke
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/deploy/gke/cluster.tf#L16-L47
  - id: eks
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/deploy/aws/cluster.tf#L30-L64
  - id: network
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/deploy/kind-coding/manifests/base/default-deny.yaml#L1-L13
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["deploy/**"]
  citations:
    - id: compose
      repo: github:wardby/wardby
      path: deploy/production/compose.yml
      lines: [34, 47]
      symbol: services.mcp
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:16c6106c64fb7258e4e5109435f63e1ba9c8c89d770169610dcf137e9a1c973b
    - id: lifecycle
      repo: github:wardby/wardby
      path: deploy/production/compose.yml
      lines: [71, 110]
      symbol: services.scheduler / services.migrate
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:52c2fde67bc922bfab91a1cba555c4145cb5adc3ce66001cd64c85df71a88311
    - id: gke
      repo: github:wardby/wardby
      path: deploy/gke/cluster.tf
      lines: [16, 47]
      symbol: google_container_cluster.runs
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:954c2c77aa5346317df383e5283a7a3727a03ce275f87e61d6e15659d40a91ec
    - id: eks
      repo: github:wardby/wardby
      path: deploy/aws/cluster.tf
      lines: [30, 64]
      symbol: aws_eks_cluster.main
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:df66bf2b8dac435db26e67d6f9777d60e98c949c3d0842c591450ee904b9ea56
    - id: network
      repo: github:wardby/wardby
      path: deploy/kind-coding/manifests/base/default-deny.yaml
      lines: [1, 13]
      symbol: default-deny-all
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:7eabaec3b06d0df67886d9c34099a1b7138d1d48a9f8ee53a4d93ba97f9fcf28
  confidence: high
---

Deployment assets materialize process and isolation boundaries: runtime and migration images, local and production Compose topologies, Kubernetes bases and overlays, cloud Terraform modules and supporting scripts. The production Compose reference separates edge, MCP, scheduler and migration services; database lifecycle is external to that topology.[^compose][^lifecycle]

Deployment connects the system through these steps:

1. Operators supply infrastructure variables, images and environment configuration. Terraform modules define cloud resources, including the Autopilot cluster on GKE and the EKS cluster on AWS.
2. The migration entry point prepares the database before runtime services depend on its schema.
3. MCP serves management requests; scheduler execution runs separately in the Compose reference.
4. Kubernetes worker namespaces start under default-deny policy. Additional policies and launcher-created resources permit the connections required by worker execution.[^gke][^eks][^lifecycle][^network]

The area owns infrastructure definitions, service accounts, network policy, resource envelopes and deployment wiring. [Configuration](overview-config.md) interprets supplied settings; [providers](overview-providers.md) launch jobs and use cloud identities; [coding workers](overview-coding.md), [native workers](overview-sandbox.md) and the [proxy](overview-coding-proxy.md) depend on the resulting isolation. [Prisma](overview-prisma.md) owns database definitions.

**What to do:** use [deployment targets](../../deploy/README.md), the [production reference](../../deploy/production/README.md) and each cloud module's guide for operational steps. Follow [CLAUDE.md, Deployment](../../CLAUDE.md#deployment-deploy--strict). Preserve database permissions needed for [proxy settlement](proxy-settlement-projections.md) when changing service identities.

[^compose]: deploy/production/compose.yml, lines 34-47.

[^lifecycle]: deploy/production/compose.yml, lines 71-110.

[^gke]: deploy/gke/cluster.tf, lines 16-47.

[^eks]: deploy/aws/cluster.tf, lines 30-64.

[^network]: deploy/kind-coding/manifests/base/default-deny.yaml, lines 1-13.
