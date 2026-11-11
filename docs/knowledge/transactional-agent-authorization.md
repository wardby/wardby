---
type: invariant
title: Agent authorization must share the mutation transaction
description: Using the default access client inside a transaction disconnects grant reads from mutation isolation.
tags: [access, transactions]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:20:14.397Z }
sources:
  - id: access
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/auth/access.ts#L55-L78
  - id: mutation
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/tools/agents.ts#L902-L912
  - id: isolation
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/tools/agents.ts#L1048-L1057
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
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:04c8d3accf60339956706f501fbf628ae620e8f368bd93c20825f6ef4f915cbb
    - id: mutation
      repo: github:wardby/wardby
      path: src/mcp/tools/agents.ts
      lines: [902, 912]
      symbol: update_agent
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:f6b5789fc562f8de5ad3e905513cd239c4ac447229ee1ee6bf4378cadffaeaa6
    - id: isolation
      repo: github:wardby/wardby
      path: src/mcp/tools/agents.ts
      lines: [1048, 1057]
      symbol: update_agent
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:3231653aa701947e8b219a7a9b0ceca1568a23acc7611375f2d3a645d17959fa
  confidence: high
---

The access helpers default to `ctx.db`; callers inside a mutation transaction must explicitly pass `tx` so grant reads participate in the same isolation boundary.[^access] Agent updates re-check write access through `tx` and commit under Serializable isolation.[^mutation][^isolation]

**Why:** checking access only before a mutation, or using the default client within it, lets a concurrent grant revocation escape the transaction’s conflict detection. The operator-facing revocation behavior is described in [Security deployment, Sharing agents](../security-deployment.md); this concept records the transaction contract behind that behavior.

[^access]: src/mcp/auth/access.ts, lines 55-78.

[^mutation]: src/mcp/tools/agents.ts, lines 902-912.

[^isolation]: src/mcp/tools/agents.ts, lines 1048-1057.
