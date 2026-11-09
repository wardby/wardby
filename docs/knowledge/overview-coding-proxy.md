---
type: overview
title: Coding proxy and package mediation
description: Run capabilities gate model reservations, package policy and optional dependency snapshots.
tags: [proxy, packages, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-09T06:04:39.000Z }
sources:
  - id: runtime
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/providers/coding-proxy/runtime.ts#L147-L268
  - id: session
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/providers/coding-proxy/proxy.ts#L1123-L1174
  - id: model
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/providers/coding-proxy/proxy.ts#L1196-L1285
  - id: plan
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/providers/coding-proxy/registry/service.ts#L662-L709
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/providers/coding-proxy/**"]
  citations:
    - id: runtime
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/runtime.ts
      lines: [147, 268]
      symbol: startConfiguredCodingProxy
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:de4a46c8e5c798d63a9b57fa67a083a982fad20fa8ba71318c03c61abe28c866
    - id: session
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [1123, 1174]
      symbol: CodingProxy.createSession
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:62b69b1a47013d33b394be95a1f9ae6123db8a371e0addb03f02896f4be30ffb
    - id: model
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [1196, 1285]
      symbol: CodingProxy.execute
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:b1336c1af890441b2fe14812405fb494711404722149fed0b94f67178ff93852
    - id: plan
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/registry/service.ts
      lines: [662, 709]
      symbol: RegistryService.planLockfile / runPlan
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:f3a6b41a918c6c88275abf0f72536341483cdcd1d3aceaf8e3b7e4821513413d
  confidence: high
---

The coding proxy is the trusted egress and metering boundary for coding workers. Its runtime composes the persistent model ledger, registry service, vulnerability auditing and optional blob-backed dependency cache. Model and registry access use distinct credentials derived for the run; optional remote MCP calls have their own pinned tool list and token hash.[^runtime][^session]

Requests proceed through these steps:

1. The executor creates a session with a model allowlist, deadline, budget and optional pinned catalog terms. Only hashes of run capabilities are persisted.
2. A model request authenticates the capability, checks protocol and body shape, verifies the model and reserves an estimated maximum cost before forwarding.
3. Authoritative provider usage settles the request and rebuilds run totals; uncertain requests retain accounting protection.
4. Package requests use the registry-only token. Lockfile planning authenticates the live run and holds a bounded plan slot before reading the body; policy and auditing determine which package bytes can be served. Optional dependency snapshots belong to the preparation phase. Remote MCP requests are relayed to the trusted gateway, while configured run-step forwarding sends observations to the control plane.[^session][^model][^plan]

The area owns model-session and request accounting, registry facts and approvals, fetch records and snapshot metadata in [Prisma](overview-prisma.md). [Coding workers](overview-coding.md) consume its routes; [storage providers](overview-providers.md) hold cache blobs; [deployment](overview-deploy.md) enforces the worker-to-proxy network boundary.

**What to do:** preserve [settlement versus reporting isolation](proxy-settlement-projections.md) and [blob absence semantics](blob-not-found-semantics.md). See [package policy](../coding-packages.md) and [worker isolation](../coding-worker-isolation.md) for operator guidance.

[^runtime]: src/providers/coding-proxy/runtime.ts, lines 147-268.

[^session]: src/providers/coding-proxy/proxy.ts, lines 1123-1174.

[^model]: src/providers/coding-proxy/proxy.ts, lines 1196-1285.

[^plan]: src/providers/coding-proxy/registry/service.ts, lines 662-709.
