---
type: overview
title: Coding proxy and package mediation
description: Run capabilities gate model reservations, package policy and optional dependency snapshots.
tags: [proxy, packages, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:22:32.722Z }
sources:
  - id: runtime
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/providers/coding-proxy/runtime.ts#L83-L159
  - id: session
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/coding-proxy/proxy.ts#L986-L1028
  - id: model
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/coding-proxy/proxy.ts#L1049-L1125
  - id: plan
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/coding-proxy/registry/service.ts#L662-L709
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/providers/coding-proxy/**"]
  citations:
    - id: runtime
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/runtime.ts
      lines: [83, 159]
      symbol: startConfiguredCodingProxy
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:e0c409bf7f5d1198dc24c3e98979f711519b4b3c0630ad841d87b27db4d11206
    - id: session
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [986, 1028]
      symbol: CodingProxy.createSession
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:976389493738ea51632f2dfbcf503b96f2506aa5105f82942efce825e075fb9e
    - id: model
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [1049, 1125]
      symbol: CodingProxy.execute
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:9d96d6504355b66561ddefb3010ff4edb753de36cea67a12fd46c7eae42f5989
    - id: plan
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/registry/service.ts
      lines: [662, 709]
      symbol: RegistryService.planLockfile / runPlan
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:f3a6b41a918c6c88275abf0f72536341483cdcd1d3aceaf8e3b7e4821513413d
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

[^runtime]: src/providers/coding-proxy/runtime.ts, lines 83-159.

[^session]: src/providers/coding-proxy/proxy.ts, lines 986-1028.

[^model]: src/providers/coding-proxy/proxy.ts, lines 1049-1125.

[^plan]: src/providers/coding-proxy/registry/service.ts, lines 662-709.
