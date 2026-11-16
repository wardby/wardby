---
type: invariant
title: Secret entry replicas must share token verification
description: A shared outcome database cannot complete a secret-entry round trip when replicas use independent signing keys.
tags: [mcp, secrets, configuration]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T11:18:44.473Z }
sources:
  - id: key
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/mcp/server.ts#L167-L186
  - id: codec
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/mcp/server.ts#L216-L233
  - id: outcome
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/mcp/tools/secret-elicitation.ts#L100-L125
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/server.ts", "src/mcp/tools/secret-elicitation*"]
  citations:
    - id: key
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [167, 186]
      symbol: loadRequestStateKey
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:bca90aafbb942461b5834c16c2b7306e744f2c5a4a9165d55b8a69aeb37051d8
    - id: codec
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [216, 233]
      symbol: buildMcpServer
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:0e80dd4983d79710bd6487abb783fd8eef1a1f5c87cf9dbdba70861eb871e538
    - id: outcome
      repo: github:wardby/wardby
      path: src/mcp/tools/secret-elicitation.ts
      lines: [100, 125]
      symbol: recordOutcome
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:1733171e7240fc8f206a4c0b3a4e45a4e587c252a9f72e0a2d8fc25f2ceae9fd
  confidence: high
---

Secret entry can mint a link, accept the browser submission, and poll the result on different HTTP replicas. Outcomes are stored in Postgres, but request-state verification still requires the same signing key on those replicas: `REQUEST_STATE_KEY` when set, otherwise a key each HTTP replica derives from the `SECRET_APP_KEY` they share (a stdio server keeps a random key of its own).[^key][^codec][^outcome]

**What to do:** preserve both shared verification and shared outcome storage when scaling this flow. Database sharing alone leaves browser links unverifiable on another replica. [Secrets and tools](../tool-secrets.md) already describes browser entry; this concept records the replica contract.

[^key]: src/mcp/server.ts, lines 167-186.

[^codec]: src/mcp/server.ts, lines 216-233.

[^outcome]: src/mcp/tools/secret-elicitation.ts, lines 100-125.
