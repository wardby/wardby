---
type: overview
title: Provider composition and routing
description: Interfaces separate orchestration from concrete model, execution, identity, persistence and source-control adapters.
tags: [providers, routing, composition]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-16T06:04:47.588Z }
sources:
  - id: registry
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/providers/index.ts#L33-L47
  - id: execution
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/executor/composition.ts#L294-L329
  - id: model
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/llm/routing.ts#L75-L87
  - id: vcs
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/vcs/routing.ts#L34-L63
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    [
      "src/providers/index.ts",
      "src/providers/llm/**",
      "src/providers/auth/**",
      "src/providers/storage/**",
      "src/providers/vcs/**",
      "src/providers/executor/**",
      "src/providers/jobs/**",
      "src/providers/datastore/**",
      "src/providers/memory/**",
      "src/providers/engine/**",
      "src/providers/secrets/**",
      "src/providers/email/**",
      "src/providers/review-host/**",
      "src/providers/issue-tracker/**",
      "src/providers/chat/**",
    ]
  citations:
    - id: registry
      repo: github:wardby/wardby
      path: src/providers/index.ts
      lines: [33, 47]
      symbol: ProviderRegistry
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:c78fde4ca7f425d997cece136728d75d49e6c8ada349a77cc4f29c0596e4b9c9
    - id: execution
      repo: github:wardby/wardby
      path: src/providers/executor/composition.ts
      lines: [294, 329]
      symbol: buildConfiguredExecutor
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:b35dbdf87d28f9b3224ca04403f8cee805a8e4ea841cf1df68d5f966ecef548b
    - id: model
      repo: github:wardby/wardby
      path: src/providers/llm/routing.ts
      lines: [75, 87]
      symbol: RoutingLlmProvider.entryFor / forRun
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:4b757bc28723803469e6625fb8ba7f9ca6d48cb496b669193d3fa4fb3023d475
    - id: vcs
      repo: github:wardby/wardby
      path: src/providers/vcs/routing.ts
      lines: [34, 63]
      symbol: RoutingVcsProvider.target
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:ff61202a27cc44a2f539ece7f2171a60a7056f7866ad624d448da47786c18eaf
  confidence: high
---

Provider interfaces are the dependencies passed to [core orchestration](overview-core.md). Adapters implement model access, jobs, execution, identity, secrets, blob storage, datastores, memory, engines and VCS; review-host, issue-tracker and chat registries support external workflows.[^registry]

Composition and execution proceed through these steps:

1. [Configuration](overview-config.md) chooses adapter kinds; composition roots construct implementations and hand them to core.
2. Executor composition routes persisted run kinds between native execution, optional native sandbox execution and container execution. Coding launchers require a usable worker-image configuration and support Docker, Kubernetes or Substrate.
3. Model routing resolves a catalog entry for new work, then can bind an adapter to a run's stored entry. Source-control routing selects local, GitHub or registered hosted implementations from repository kind and refuses unconfigured kinds at use time. Hosted repositories never fall back to GitHub.
4. Jobs isolate [coding workers](overview-coding.md); model credentials and VCS finalization remain on the trusted side, while the [coding proxy](overview-coding-proxy.md) meters worker model traffic.[^execution][^model][^vcs]

Adapters own external API translation, lifecycle handles and error semantics. [Prisma](overview-prisma.md) holds durable accounting and workflow state, while storage adapters hold blobs. [Deployment modules](overview-deploy.md) supply infrastructure and identities.

**What to do:** review [blob error semantics](blob-not-found-semantics.md), [bounded artifact reads](bounded-file-descriptor.md), [staging failure isolation](workspace-staging-failure.md) and [private/shared datastore scoping](private-datastore-shared-boundary.md) before replacing an adapter. See [runtime architecture](../architecture-runtime.md) for the process model.

[^registry]: src/providers/index.ts, lines 33-47.

[^execution]: src/providers/executor/composition.ts, lines 294-329.

[^model]: src/providers/llm/routing.ts, lines 75-87.

[^vcs]: src/providers/vcs/routing.ts, lines 34-63.
