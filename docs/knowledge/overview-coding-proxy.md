---
type: overview
title: Coding proxy and package mediation
description: Run capabilities gate model reservations, package policy and optional dependency snapshots.
tags: [proxy, packages, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-16T06:04:47.588Z }
sources:
  - id: runtime
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/coding-proxy/runtime.ts#L267-L317
  - id: session
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/coding-proxy/proxy.ts#L1142-L1197
  - id: model
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/coding-proxy/proxy.ts#L1219-L1284
  - id: plan
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/coding-proxy/registry/service.ts#L668-L715
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/providers/coding-proxy/**"]
  citations:
    - id: runtime
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/runtime.ts
      lines: [267, 317]
      symbol: startConfiguredCodingProxy
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:5707326924e9e0c1bfae06e5977e2c06daf548c9b8c778d3bea10b522c395efc
    - id: session
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [1142, 1197]
      symbol: CodingProxy.createSession
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:e05b3d7c87c98d6b93add7a4309a4800e3a32f4bc2397d29842622b15eaca026
    - id: model
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [1219, 1284]
      symbol: CodingProxy.execute
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:00db7965d92fabb6b53c3581f17826cc9036ef61e47d97e6e2efa74221b23ed2
    - id: plan
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/registry/service.ts
      lines: [668, 715]
      symbol: RegistryService.planLockfile / runPlan
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:f3a6b41a918c6c88275abf0f72536341483cdcd1d3aceaf8e3b7e4821513413d
  confidence: high
---

The coding proxy is the trusted egress and metering boundary for coding workers. Its runtime composes the persistent model ledger, registry service, vulnerability auditing and optional blob-backed dependency cache. Model and registry access use distinct credentials derived for the run; sessions can also pin remote MCP tools with a separate token hash.[^runtime][^session]

Requests proceed through these steps:

1. The executor creates a session with a model allowlist, deadline, budget and optional pinned catalog terms. Only hashes of run capabilities are persisted.
2. A model request authenticates the capability, checks protocol and body shape, verifies the model and reserves an estimated maximum cost before forwarding.
3. Authoritative provider usage settles the request and rebuilds run totals; uncertain requests retain accounting protection.
4. Package requests use the registry-only token. Lockfile planning authenticates the live run and holds a bounded plan slot before reading the body; policy and auditing determine which package bytes can be served. Optional dependency snapshots belong to the preparation phase.[^session][^model][^plan]

The area owns model-session and request accounting, registry facts and approvals, fetch records and snapshot metadata in [Prisma](overview-prisma.md). [Coding workers](overview-coding.md) consume its routes; [storage providers](overview-providers.md) hold cache blobs; [deployment](overview-deploy.md) enforces the worker-to-proxy network boundary.

**What to do:** preserve [settlement versus reporting isolation](proxy-settlement-projections.md) and [blob absence semantics](blob-not-found-semantics.md). See [package policy](../coding-packages.md) and [worker isolation](../coding-worker-isolation.md) for operator guidance.

[^runtime]: src/providers/coding-proxy/runtime.ts, lines 267-317.

[^session]: src/providers/coding-proxy/proxy.ts, lines 1142-1197.

[^model]: src/providers/coding-proxy/proxy.ts, lines 1219-1284.

[^plan]: src/providers/coding-proxy/registry/service.ts, lines 668-715.
