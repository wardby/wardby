---
type: overview
title: Viewer, observability and knowledge tooling
description: Read projections, metrics and cited knowledge expose runtime state and architecture without owning execution.
tags: [viewer, observability, knowledge, tooling]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:23:52.509Z }
sources:
  - id: viewer
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/viewer/http.ts#L109-L137
  - id: events
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/viewer/event-bus.ts#L59-L113
  - id: metrics
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/observability/metrics-server.ts#L21-L43
  - id: knowledge
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/knowledge/check.ts#L69-L87
  - id: fixtures
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/tools/codex-request-shape.ts#L48-L76
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/viewer/**", "src/observability/**", "src/knowledge/**", "src/tools/**"]
  citations:
    - id: viewer
      repo: github:wardby/wardby
      path: src/viewer/http.ts
      lines: [109, 137]
      symbol: createViewerApi.handle
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:03dea11ad42963e9244fcd1b0ecc870b56dd2c2f71524de88138dfe852fbdea5
    - id: events
      repo: github:wardby/wardby
      path: src/viewer/event-bus.ts
      lines: [59, 113]
      symbol: createViewerEventBus
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:6a7a2ebbe033f611c7a94ab29f2fcdaf8c1957bf680a36e502406232d81a0301
    - id: metrics
      repo: github:wardby/wardby
      path: src/observability/metrics-server.ts
      lines: [21, 43]
      symbol: startMetricsServer
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:19b994cd518149718981334eefc2beca5508501f131b2fab8b1f046764920700
    - id: knowledge
      repo: github:wardby/wardby
      path: src/knowledge/check.ts
      lines: [69, 87]
      symbol: checkBundle
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:819ec7779ed8ce9529dfe3364d02936c31f88d98125ad3429094729510151bf1
    - id: fixtures
      repo: github:wardby/wardby
      path: src/tools/codex-request-shape.ts
      lines: [48, 76]
      symbol: requestShape
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:e0dfb71fb14012af5b9a41cc893fda12418fd55e11a83ec1ca813c476a07cd79
  confidence: high
---

These supporting surfaces turn authoritative state into operator views and engineering evidence. Viewer serves authenticated graph and run-detail projections plus live events; observability exposes Prometheus data; knowledge tooling parses, checks and selects cited concepts; developer tools record and compare provider request fixtures.[^viewer][^metrics][^knowledge][^fixtures]

The main flows are:

1. Viewer authenticates a request and requires admin:view before serving graph, run, infrastructure or event routes.
2. A lazy Postgres LISTEN connection validates notifications and fans them out to subscribers. The SSE layer signals reconnection gaps so clients can refetch authoritative projections.
3. The metrics listener exposes its supplied registry at a separate endpoint; the coding proxy supplies request observations.
4. Knowledge checks parse each concept and compare citation hashes against repository content. Fixture-shape tooling summarizes request keys and types so SDK changes can be reviewed against proxy validation.[^viewer][^events][^metrics][^knowledge][^fixtures]

The area owns API schemas, projections, stream subscriptions, metric registries and knowledge validation results. [Prisma](overview-prisma.md) owns durable run state and notification triggers. [MCP](overview-mcp.md) composes viewer authentication, the [proxy](overview-coding-proxy.md) supplies metering events, and [coding dispatch](overview-core.md) incorporates repository knowledge.

**What to do:** preserve [viewer write isolation](viewer-notify-write-isolation.md); observation must not become a dependency of authoritative state changes. See [viewer API](../viewer-api.md), [observability](../observability.md), [architecture knowledge](../knowledge.md) and [Codex request compatibility](../coding-worker-isolation.md) for the owning guides.

[^viewer]: src/viewer/http.ts, lines 109-137.

[^events]: src/viewer/event-bus.ts, lines 59-113.

[^metrics]: src/observability/metrics-server.ts, lines 21-43.

[^knowledge]: src/knowledge/check.ts, lines 69-87.

[^fixtures]: src/tools/codex-request-shape.ts, lines 48-76.
