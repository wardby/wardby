---
type: invariant
title: Agent authorization must share the mutation transaction
description: Using the default access client inside a transaction disconnects grant reads from mutation isolation.
tags: [access, transactions]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T10:20:14.397Z }
sources:
  - id: access
    url: https://github.com/wardby/wardby/blob/9c0f910f919dec4f1a2149bae78612cda41f6007/src/mcp/auth/access.ts#L47-L70
  - id: mutation
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/mcp/tools/agents.ts#L847-L857
  - id: isolation
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/mcp/tools/agents.ts#L975-L985
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/auth/**", "src/mcp/tools/**"]
  citations:
    - id: access
      repo: github:wardby/wardby
      path: src/mcp/auth/access.ts
      lines: [47, 70]
      symbol: assertAgentAccess
      sha: 9c0f910f919dec4f1a2149bae78612cda41f6007
      spanHash: sha256:04c8d3accf60339956706f501fbf628ae620e8f368bd93c20825f6ef4f915cbb
    - id: mutation
      repo: github:wardby/wardby
      path: src/mcp/tools/agents.ts
      lines: [847, 857]
      symbol: update_agent
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:f6b5789fc562f8de5ad3e905513cd239c4ac447229ee1ee6bf4378cadffaeaa6
    - id: isolation
      repo: github:wardby/wardby
      path: src/mcp/tools/agents.ts
      lines: [975, 985]
      symbol: update_agent
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:d3c25b8684e11ec56311649d617f6e933d380d4d063257e2f21804f502b2b832
  confidence: high
---

The access helpers default to `ctx.db`; callers inside a mutation transaction must explicitly pass `tx` so grant reads participate in the same isolation boundary.[^access] Agent updates re-check write access through `tx` and commit under Serializable isolation.[^mutation][^isolation]

**Why:** checking access only before a mutation, or using the default client within it, lets a concurrent grant revocation escape the transaction’s conflict detection. The operator-facing revocation behavior is described in [Security deployment, Sharing agents](../security-deployment.md); this concept records the transaction contract behind that behavior.

[^access]: src/mcp/auth/access.ts, lines 47-70.

[^mutation]: src/mcp/tools/agents.ts, lines 847-857.

[^isolation]: src/mcp/tools/agents.ts, lines 975-985.
