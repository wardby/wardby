---
type: invariant
title: Agent authorization must share the mutation transaction
description: Using the default access client inside a transaction disconnects grant reads from mutation isolation.
tags: [access, transactions]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:20:14.397Z }
sources:
  - id: access
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/auth/access.ts#L56-L79
  - id: mutation
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/tools/agents.ts#L1098-L1108
  - id: isolation
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/tools/agents.ts#L1278-L1289
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/auth/**", "src/mcp/tools/**"]
  citations:
    - id: access
      repo: github:wardby/wardby
      path: src/mcp/auth/access.ts
      lines: [56, 79]
      symbol: assertAgentAccess
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:04c8d3accf60339956706f501fbf628ae620e8f368bd93c20825f6ef4f915cbb
    - id: mutation
      repo: github:wardby/wardby
      path: src/mcp/tools/agents.ts
      lines: [1098, 1108]
      symbol: update_agent
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:f6b5789fc562f8de5ad3e905513cd239c4ac447229ee1ee6bf4378cadffaeaa6
    - id: isolation
      repo: github:wardby/wardby
      path: src/mcp/tools/agents.ts
      lines: [1278, 1289]
      symbol: update_agent
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:753fcb497770aa43d0f4ca3eb8a089feb087979d49c5ce53ecf6de74645f566c
  confidence: high
---

The access helpers default to `ctx.db`; callers inside a mutation transaction must explicitly pass `tx` so grant reads participate in the same isolation boundary.[^access] Agent updates re-check write access through `tx` and commit under Serializable isolation.[^mutation][^isolation]

**Why:** checking access only before a mutation, or using the default client within it, lets a concurrent grant revocation escape the transaction’s conflict detection. The operator-facing revocation behavior is described in [Security deployment, Sharing agents](../security-deployment.md); this concept records the transaction contract behind that behavior.

[^access]: src/mcp/auth/access.ts, lines 56-79.

[^mutation]: src/mcp/tools/agents.ts, lines 1098-1108.

[^isolation]: src/mcp/tools/agents.ts, lines 1278-1289.
