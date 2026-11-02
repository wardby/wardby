---
type: invariant
title: Public write and capability binding must serialize
description: Opposing grant and attachment checks must commit atomically to prevent each from approving the other's absent state.
tags:
  - mcp
  - access
  - transactions
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-02T06:04:39.135Z }
sources:
  - id: grants
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/tools/grants.ts#L108-L110
  - id: grant-check
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/tools/grants.ts#L181-L204
  - id: binding-check
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/tools/tools.ts#L354-L382
  - id: binding-commit
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/tools/tools.ts#L417-L443
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    - "src/mcp/tools/**"
    - "src/mcp/auth/access.ts"
    - "src/core/grants.ts"
  citations:
    - id: grants
      repo: github:wardby/wardby
      path: src/mcp/tools/grants.ts
      lines: [108, 110]
      symbol: inSerializable
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:e0aa9e50d053533f21459a17ccd902627d92f0ba25ac2d72f620ee5ed1f6a06d
    - id: grant-check
      repo: github:wardby/wardby
      path: src/mcp/tools/grants.ts
      lines: [181, 204]
      symbol: grant_access
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:860e88b2ed792d35b99f63a3f729f3a4afb6fbb73b96bf75bc06d94b3ada6969
    - id: binding-check
      repo: github:wardby/wardby
      path: src/mcp/tools/tools.ts
      lines: [354, 382]
      symbol: attach_tool
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:23286b0504f4d6348cda9fdd8ad6001acfa0bea360304830cbab55ad53b75521
    - id: binding-commit
      repo: github:wardby/wardby
      path: src/mcp/tools/tools.ts
      lines: [417, 443]
      symbol: attach_tool
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:a80e5866aca15f2bcb92d0bd64320638eaa98153c29159df53d750ead8b987c7
  confidence: high
---

[Sharing agents](../security-deployment.md#sharing-agents) and [the help article](../../help/sharing-agents.md) already describe the exclusion between everyone-write and owner-held bindings. The additional contract is concurrency: the grant path reads the agent's bindings and writes the grant inside a Serializable transaction, while capability attachment reads the grant and writes its attachment inside another Serializable transaction.[^grants][^grant-check][^binding-check][^binding-commit]

If either check moves outside its transaction, both requests can observe an empty opposing state and approve a combination that neither permits alone. Passing the transaction client through the guard is as necessary as keeping the write inside it. This complements [transactional agent authorization](transactional-agent-authorization.md): access checks protect the caller's authority, while these opposing reads protect the resulting agent's authority. See [MCP management](overview-mcp.md).

**What to do:** preserve both transaction-scoped reads and Serializable commits when adding a binding path or changing public grants; a handler-level preflight alone cannot enforce the exclusion.

[^grants]: src/mcp/tools/grants.ts, lines 108-110.

[^grant-check]: src/mcp/tools/grants.ts, lines 181-204.

[^binding-check]: src/mcp/tools/tools.ts, lines 354-382.

[^binding-commit]: src/mcp/tools/tools.ts, lines 417-443.
