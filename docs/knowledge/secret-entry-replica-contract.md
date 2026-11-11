---
type: invariant
title: Secret entry replicas must share token verification
description: A shared outcome database cannot complete a secret-entry round trip when replicas use independent signing keys.
tags: [mcp, secrets, configuration]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T11:18:44.473Z }
sources:
  - id: key
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/server.ts#L151-L180
  - id: codec
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/server.ts#L212-L227
  - id: outcome
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/tools/secret-elicitation.ts#L100-L125
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/server.ts", "src/mcp/tools/secret-elicitation*"]
  citations:
    - id: key
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [151, 180]
      symbol: loadRequestStateKey
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:99eae6dc8b97d2265e357a8cf9bce4fd1174b7fa5f8bda522b156878a0601289
    - id: codec
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [212, 227]
      symbol: buildMcpServer
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:26b0f3227ab9f9ee361a12fe7fc9bc0ba89f8f10dd2bb6de146723c6b206a969
    - id: outcome
      repo: github:wardby/wardby
      path: src/mcp/tools/secret-elicitation.ts
      lines: [100, 125]
      symbol: recordOutcome
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:1733171e7240fc8f206a4c0b3a4e45a4e587c252a9f72e0a2d8fc25f2ceae9fd
  confidence: high
---

Secret entry can mint a link, accept the browser submission, and poll the result on different HTTP replicas. Outcomes are stored in Postgres, but request-state verification still requires the same signing key on those replicas: `REQUEST_STATE_KEY` when set, otherwise a key each HTTP replica derives from the `SECRET_APP_KEY` they share (a stdio server keeps a random key of its own).[^key][^codec][^outcome]

**What to do:** preserve both shared verification and shared outcome storage when scaling this flow. Database sharing alone leaves browser links unverifiable on another replica. [Secrets and tools](../tool-secrets.md) already describes browser entry; this concept records the replica contract.

[^key]: src/mcp/server.ts, lines 151-180.

[^codec]: src/mcp/server.ts, lines 212-227.

[^outcome]: src/mcp/tools/secret-elicitation.ts, lines 100-125.
