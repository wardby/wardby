---
type: invariant
title: Agent authorization must share the mutation transaction
description: Using the default access client inside a transaction disconnects grant reads from mutation isolation.
tags: [access, transactions]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:20:14.397Z }
sources:
  - id: access
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/auth/access.ts#L55-L78
  - id: mutation
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/tools/agents.ts#L906-L916
  - id: isolation
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/tools/agents.ts#L1063-L1075
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/auth/**", "src/mcp/tools/**"]
  citations:
    - id: access
      repo: github:wardby/wardby
      path: src/mcp/auth/access.ts
      lines: [55, 78]
      symbol: assertAgentAccess
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:04c8d3accf60339956706f501fbf628ae620e8f368bd93c20825f6ef4f915cbb
    - id: mutation
      repo: github:wardby/wardby
      path: src/mcp/tools/agents.ts
      lines: [906, 916]
      symbol: update_agent
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:f6b5789fc562f8de5ad3e905513cd239c4ac447229ee1ee6bf4378cadffaeaa6
    - id: isolation
      repo: github:wardby/wardby
      path: src/mcp/tools/agents.ts
      lines: [1063, 1075]
      symbol: update_agent
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:7921167d0fd4775aaa9c542480fd158837dbd16638cc1daf429738c69a8733bf
  confidence: high
---

The access helpers default to `ctx.db`; callers inside a mutation transaction must explicitly pass `tx` so grant reads participate in the same isolation boundary.[^access] Agent updates re-check write access through `tx` and commit under Serializable isolation.[^mutation][^isolation]

**Why:** checking access only before a mutation, or using the default client within it, lets a concurrent grant revocation escape the transaction’s conflict detection. The operator-facing revocation behavior is described in [Security deployment, Sharing agents](../security-deployment.md); this concept records the transaction contract behind that behavior.

[^access]: src/mcp/auth/access.ts, lines 55-78.

[^mutation]: src/mcp/tools/agents.ts, lines 906-916.

[^isolation]: src/mcp/tools/agents.ts, lines 1063-1075.
