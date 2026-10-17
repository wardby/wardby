---
type: overview
title: Configuration and process bootstrap
description: Environment loading precedes typed feature settings and provider composition.
tags: [config, environment, bootstrap]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:22:13.475Z }
sources:
  - id: bootstrap
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/env.ts#L11-L27
  - id: providers
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/config/providers.ts#L74-L87
  - id: cache
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/config/dependency-cache.ts#L36-L53
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/config/**", "src/env.ts"]
  citations:
    - id: bootstrap
      repo: github:wardby/wardby
      path: src/env.ts
      lines: [11, 27]
      symbol: dotenvFlow.config
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:71c46404eb01aceb2d30a7617bff1df60437a1ded819b7016fd9d8bc08a08363
    - id: providers
      repo: github:wardby/wardby
      path: src/config/providers.ts
      lines: [74, 87]
      symbol: loadProviderConfig
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:32457f939e01bc19814b04ef4ed3d7d944416518080247c7d0e1eb318c5cc5f6
    - id: cache
      repo: github:wardby/wardby
      path: src/config/dependency-cache.ts
      lines: [36, 53]
      symbol: loadDependencyCacheConfig
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:643c0433fac3665962e6b995781cabf909aa7bc43bd150d62c61bca7b140c564
  confidence: high
---

Configuration turns process environment into provider selections and feature settings. Bootstrap first installs the process HTTP runtime, then loads the project-local Wardby environment before the project's own cascade. Existing process variables take precedence.[^bootstrap]

Startup proceeds through these steps:

1. An entry point imports bootstrap before modules consume environment values.
2. Loaders select provider kinds and parse settings for enabled integrations. The provider selector supplies defaults; feature loaders own additional validation.
3. Composition roots build adapters using those settings. A feature may remain unavailable without its prerequisite: dependency caching needs both its enable flag and blob-store configuration.[^bootstrap][^providers][^cache]

The area owns configuration shapes and validation, not durable settings or credential storage. [Providers](overview-providers.md) construct adapters; [coding workers](overview-coding.md), [native isolation](overview-sandbox.md) and the [coding proxy](overview-coding-proxy.md) consume their own subsets. [CLI bootstrap](overview-cli.md) writes project-local configuration, and [deployment modules](overview-deploy.md) supply remote process settings.

**What to do:** keep initialization order intact and validate through the relevant loader before starting listeners. The [HTTP dispatcher contract](http-dispatcher-bootstrap.md) explains why bootstrap order affects network correctness even without Kubernetes jobs. See [getting started](../getting-started.md) for operator configuration.

[^bootstrap]: src/env.ts, lines 11-27.

[^providers]: src/config/providers.ts, lines 74-87.

[^cache]: src/config/dependency-cache.ts, lines 36-53.
