---
type: invariant
title: Secret entry replicas must share token verification
description: A shared outcome database cannot complete a secret-entry round trip when replicas use independent signing keys.
tags: [mcp, secrets, configuration]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T11:18:44.473Z }
sources:
  - id: key
    url: https://github.com/wardby/wardby/blob/0cd83fece6e5dafbb229aee4c293953e354cb42d/src/mcp/server.ts#L139-L155
  - id: codec
    url: https://github.com/wardby/wardby/blob/0cd83fece6e5dafbb229aee4c293953e354cb42d/src/mcp/server.ts#L191-L202
  - id: outcome
    url: https://github.com/wardby/wardby/blob/0cd83fece6e5dafbb229aee4c293953e354cb42d/src/mcp/tools/secret-elicitation.ts#L79-L104
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/server.ts", "src/mcp/tools/secret-elicitation*"]
  citations:
    - id: key
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [139, 155]
      symbol: loadRequestStateKey
      sha: 0cd83fece6e5dafbb229aee4c293953e354cb42d
      spanHash: sha256:09a8e266ca81faa6a3af750f87ab4b7892dba80a2fde187a3af16df22e3e8aa9
    - id: codec
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [191, 202]
      symbol: buildMcpServer
      sha: 0cd83fece6e5dafbb229aee4c293953e354cb42d
      spanHash: sha256:32779f2edf44c96fb4b295df8feceecaf9f9034c67513ac7074ad6423abf766b
    - id: outcome
      repo: github:wardby/wardby
      path: src/mcp/tools/secret-elicitation.ts
      lines: [79, 104]
      symbol: recordOutcome
      sha: 0cd83fece6e5dafbb229aee4c293953e354cb42d
      spanHash: sha256:1733171e7240fc8f206a4c0b3a4e45a4e587c252a9f72e0a2d8fc25f2ceae9fd
  confidence: high
---

Secret entry can mint a link, accept the browser submission, and poll the result on different HTTP replicas. Outcomes are stored in Postgres, but request-state verification still requires the same `REQUEST_STATE_KEY` on those replicas; the unset fallback generates an independent random key per process.[^key][^codec][^outcome]

**What to do:** preserve both shared verification and shared outcome storage when scaling this flow. Database sharing alone leaves browser links unverifiable on another replica. [Secrets and tools](../tool-secrets.md) already describes browser entry; this concept records the replica contract.

[^key]: src/mcp/server.ts, lines 139-155.

[^codec]: src/mcp/server.ts, lines 191-202.

[^outcome]: src/mcp/tools/secret-elicitation.ts, lines 79-104.
