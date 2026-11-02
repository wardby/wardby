---
type: overview
title: Coding proxy and package mediation
description: Run capabilities gate model reservations, package policy and optional dependency snapshots.
tags: [proxy, packages, budgets]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-02T06:04:39.135Z }
sources:
  - id: runtime
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/providers/coding-proxy/runtime.ts#L88-L175
  - id: session
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/providers/coding-proxy/proxy.ts#L986-L1028
  - id: model
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/providers/coding-proxy/proxy.ts#L1048-L1130
  - id: plan
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/providers/coding-proxy/registry/service.ts#L662-L709
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/providers/coding-proxy/**"]
  citations:
    - id: runtime
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/runtime.ts
      lines: [88, 175]
      symbol: startConfiguredCodingProxy
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:b5bd909a474f17c48733c28b49e13251270871b2570be03042896dadd5cf0be3
    - id: session
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [986, 1028]
      symbol: CodingProxy.createSession
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:976389493738ea51632f2dfbcf503b96f2506aa5105f82942efce825e075fb9e
    - id: model
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/proxy.ts
      lines: [1048, 1130]
      symbol: CodingProxy.execute
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:2f04995c943d2bde12d35a238a616f3e0a2c579c800c7cf106825442eab12b64
    - id: plan
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/registry/service.ts
      lines: [662, 709]
      symbol: RegistryService.planLockfile / runPlan
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:f3a6b41a918c6c88275abf0f72536341483cdcd1d3aceaf8e3b7e4821513413d
  confidence: high
---

The coding proxy is the trusted egress and metering boundary for coding workers. Its runtime composes the persistent model ledger, registry service, vulnerability auditing and optional blob-backed dependency cache. Model and registry access use distinct credentials derived for the run.[^runtime][^session]

Requests proceed through these steps:

1. The executor creates a session with a model allowlist, deadline, budget and optional pinned catalog terms. Only hashes of run capabilities are persisted.
2. A model request authenticates the capability, checks protocol and body shape, verifies the model and reserves a cost hold before forwarding. The hold can use a prior conversation reply; a failed lookup retains the conservative ceiling.
3. Authoritative provider usage settles the request and rebuilds run totals; uncertain requests retain accounting protection.
4. Package requests use the registry-only token. Lockfile planning authenticates the live run and holds a bounded plan slot before reading the body; policy and auditing determine which package bytes can be served. Optional dependency snapshots belong to the preparation phase.[^session][^model][^plan]

The area owns model-session and request accounting, registry facts and approvals, fetch records and snapshot metadata in [Prisma](overview-prisma.md). [Coding workers](overview-coding.md) consume its routes; [storage providers](overview-providers.md) hold cache blobs; [deployment](overview-deploy.md) enforces the worker-to-proxy network boundary.

**What to do:** preserve [settlement versus reporting isolation](proxy-settlement-projections.md) and [blob absence semantics](blob-not-found-semantics.md). See [package policy](../coding-packages.md) and [worker isolation](../coding-worker-isolation.md) for operator guidance.

[^runtime]: src/providers/coding-proxy/runtime.ts, lines 88-175.

[^session]: src/providers/coding-proxy/proxy.ts, lines 986-1028.

[^model]: src/providers/coding-proxy/proxy.ts, lines 1048-1130.

[^plan]: src/providers/coding-proxy/registry/service.ts, lines 662-709.
