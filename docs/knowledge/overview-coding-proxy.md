---
type: overview
title: Coding proxy and package mediation
description: Run capabilities gate model reservations, package policy and optional dependency snapshots.
tags: [proxy, packages, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:22:32.722Z }
sources:
  - id: runtime
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/coding-proxy/runtime.ts#L314-L410
  - id: session
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/coding-proxy/proxy.ts#L1262-L1318
  - id: model
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/coding-proxy/proxy.ts#L1346-L1420
  - id: plan
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/coding-proxy/registry/service.ts#L854-L915
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/providers/coding-proxy/**"]
  citations:
    - id: runtime
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/runtime.ts
      lines: [314, 410]
      symbol: startConfiguredCodingProxy
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:c2bc812a6127fbc0bc55a5f8d57b9d3049cb41e648fe152316f7de7c5a0476b1
    - id: session
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [1262, 1318]
      symbol: CodingProxy.createSession
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:5d3b103d1a0010764e3be1887dd0cae01871a81f703628ac1484f5e6a58f08fd
    - id: model
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [1346, 1420]
      symbol: CodingProxy.execute
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:d5db5febc7e859426a007a1720d9fd725de31e2a9ab79cd84debf21181bb9b11
    - id: plan
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/registry/service.ts
      lines: [854, 915]
      symbol: RegistryService.planLockfile / runPlan
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:098cdc3bfad87513727db318bf648ef802ba19a35f20a81e534e35d74e6129f4
  confidence: high
---

The coding proxy is the trusted egress and metering boundary for coding workers. Its runtime composes the persistent model ledger, registry service, vulnerability auditing and optional blob-backed dependency cache. Model and registry access use distinct credentials derived for the run.[^runtime][^session]

Requests proceed through these steps:

1. The executor creates a session with a model allowlist, deadline, budget and optional pinned catalog terms. Only hashes of run capabilities are persisted.
2. A model request authenticates the capability, checks protocol and body shape, verifies the model and reserves an estimated maximum cost before forwarding.
3. Authoritative provider usage settles the request and rebuilds run totals; uncertain requests retain accounting protection.
4. Package requests use the registry-only token. Lockfile planning authenticates the live run and holds a bounded plan slot before reading the body; policy and auditing determine which package bytes can be served. Optional dependency snapshots belong to the preparation phase.[^session][^model][^plan]

The area owns model-session and request accounting, registry facts and approvals, fetch records and snapshot metadata in [Prisma](overview-prisma.md). [Coding workers](overview-coding.md) consume its routes; [storage providers](overview-providers.md) hold cache blobs; [deployment](overview-deploy.md) enforces the worker-to-proxy network boundary.

**What to do:** preserve [settlement versus reporting isolation](proxy-settlement-projections.md) and [blob absence semantics](blob-not-found-semantics.md). See [package policy](../coding-packages.md) and [worker isolation](../coding-worker-isolation.md) for operator guidance.

[^runtime]: src/providers/coding-proxy/runtime.ts, lines 314-410.

[^session]: src/providers/coding-proxy/proxy.ts, lines 1262-1318.

[^model]: src/providers/coding-proxy/proxy.ts, lines 1346-1420.

[^plan]: src/providers/coding-proxy/registry/service.ts, lines 854-915.
