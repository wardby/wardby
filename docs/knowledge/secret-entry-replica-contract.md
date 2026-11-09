---
type: invariant
title: Secret entry replicas must share token verification
description: A shared outcome database cannot complete a secret-entry round trip when replicas use independent signing keys.
tags: [mcp, secrets, configuration]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T11:18:44.473Z }
sources:
  - id: key
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/server.ts#L164-L180
  - id: codec
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/server.ts#L211-L227
  - id: outcome
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/tools/secret-elicitation.ts#L100-L125
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/server.ts", "src/mcp/tools/secret-elicitation*"]
  citations:
    - id: key
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [164, 180]
      symbol: loadRequestStateKey
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:737bc4ac276e920767713a624a1977b6514ebc6588707792e85919d74a7b9c04
    - id: codec
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [211, 227]
      symbol: buildMcpServer
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:864a79e2dc5d312b29cd3c1fe2dcbe413419cc2455e677092ba0fe089027b25d
    - id: outcome
      repo: github:wardby/wardby
      path: src/mcp/tools/secret-elicitation.ts
      lines: [100, 125]
      symbol: recordOutcome
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:1733171e7240fc8f206a4c0b3a4e45a4e587c252a9f72e0a2d8fc25f2ceae9fd
  confidence: high
---

Secret entry can mint a link, accept the browser submission, and poll the result on different HTTP replicas. Outcomes are stored in Postgres, but request-state verification still requires the same signing key on those replicas: `REQUEST_STATE_KEY` when set, otherwise a key each HTTP replica derives from the `SECRET_APP_KEY` they share (a stdio server keeps a random key of its own).[^key][^codec][^outcome]

**What to do:** preserve both shared verification and shared outcome storage when scaling this flow. Database sharing alone leaves browser links unverifiable on another replica. [Secrets and tools](../tool-secrets.md) already describes browser entry; this concept records the replica contract.

[^key]: src/mcp/server.ts, lines 164-180.

[^codec]: src/mcp/server.ts, lines 211-227.

[^outcome]: src/mcp/tools/secret-elicitation.ts, lines 100-125.
