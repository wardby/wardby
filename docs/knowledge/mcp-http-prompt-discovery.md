---
type: pitfall
title: HTTP prompt discovery cannot use per-call identity
description: The HTTP factory exposes everyone-readable agent prompts rather than the authenticated caller’s full agent set.
tags: [mcp, access, discovery]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T11:18:44.473Z }
sources:
  - id: context
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/server.ts#L236-L260
  - id: prompts
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/server.ts#L326-L358
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/server.ts", "src/mcp/transport/**"]
  citations:
    - id: context
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [236, 260]
      symbol: resolveCtx
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:e44772fb56c6bd94fe80f9a217ad26e1a5a580cd380f363db476fa206d4ba288
    - id: prompts
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [326, 358]
      symbol: factory
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:e2b7273522836d35f55b7bf068062a488b1eae0cd47520d35a67f89acd0f731f
  confidence: high
---

HTTP identity is resolved from each dispatched call, after the server factory builds the prompt list. The factory therefore registers only agents granted at least read to everyone; stdio can use its already established fixed context. Failure to build this optional list does not prevent tool registration.[^context][^prompts]

**What to do:** do not treat a missing HTTP prompt as proof that the caller lacks agent access, or widen the factory’s query to all agents. Caller-specific discovery needs request identity before prompt registration.

[^context]: src/mcp/server.ts, lines 236-260.

[^prompts]: src/mcp/server.ts, lines 326-358.
