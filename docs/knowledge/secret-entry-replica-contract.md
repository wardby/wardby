---
type: invariant
title: Secret entry replicas must share token verification
description: A shared outcome database cannot complete a secret-entry round trip when replicas use independent signing keys.
tags: [mcp, secrets, configuration]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T11:18:44.473Z }
sources:
  - id: key
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/server.ts#L174-L188
  - id: codec
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/server.ts#L224-L235
  - id: outcome
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/tools/secret-elicitation.ts#L224-L237
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/server.ts", "src/mcp/tools/secret-elicitation*"]
  citations:
    - id: key
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [174, 188]
      symbol: loadRequestStateKey
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:6502ef82e2be065bb64899c2862879a27be05b55dba5212fc8423d1ee32315ae
    - id: codec
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [224, 235]
      symbol: buildMcpServer
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:4d15153dd94120580b21d2d03e016d18349985a8d9a0d8f0f9c01bbf20e5c142
    - id: outcome
      repo: github:wardby/wardby
      path: src/mcp/tools/secret-elicitation.ts
      lines: [224, 237]
      symbol: recordOutcome
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:689f7d95af7c2d0e45c0685656a21dd949e25bb9d463606cc2962a7c31abddae
  confidence: high
---

Secret entry can mint a link, accept the browser submission, and poll the result on different HTTP replicas. Outcomes are stored in Postgres, but request-state verification still requires the same signing key on those replicas: `REQUEST_STATE_KEY` when set, otherwise a key each HTTP replica derives from the `SECRET_APP_KEY` they share (a stdio server keeps a random key of its own).[^key][^codec][^outcome]

**What to do:** preserve both shared verification and shared outcome storage when scaling this flow. Database sharing alone leaves browser links unverifiable on another replica. [Secrets and tools](../tool-secrets.md) already describes browser entry; this concept records the replica contract.

[^key]: src/mcp/server.ts, lines 174-188.

[^codec]: src/mcp/server.ts, lines 224-235.

[^outcome]: src/mcp/tools/secret-elicitation.ts, lines 224-237.
