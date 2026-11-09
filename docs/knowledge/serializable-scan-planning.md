---
type: pitfall
title: Serializable scans can couple unrelated ownership actions
description: Bounded retries cannot reliably compensate for relation-wide predicate locks on small tables.
tags:
  - mcp
  - transactions
  - concurrency
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-09T06:04:39.000Z }
sources:
  - id: planning
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/core/serializable-retry.ts#L19-L48
  - id: grants
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/tools/grants.ts#L128-L138
  - id: attachment
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/tools/mcp-servers.ts#L447-L461
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    - "src/core/serializable-retry.ts"
    - "src/mcp/tools/grants.ts"
    - "src/mcp/tools/mcp-servers.ts"
    - "src/mcp/tools/agents.ts"
  citations:
    - id: planning
      repo: github:wardby/wardby
      path: src/core/serializable-retry.ts
      lines: [19, 48]
      symbol: preferIndexScans / withSerializableRetry
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:84eff80bb8dcd54ef537139cfb84efd8099bf464c79427a3e0bbffdee2aac7c1
    - id: grants
      repo: github:wardby/wardby
      path: src/mcp/tools/grants.ts
      lines: [128, 138]
      symbol: inSerializable
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:4de396ec2cd017151334533c1a525edb0a021f2ec9029749d0849721f4492142
    - id: attachment
      repo: github:wardby/wardby
      path: src/mcp/tools/mcp-servers.ts
      lines: [447, 461]
      symbol: registerMcpServerTools attach transaction
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:5a660dcdf6b4a7451b9481a796f7566b4a7b836d0f87b7c72b56e711be7984de
  confidence: high
---

Small grant and ownership tables can cause PostgreSQL to choose sequential scans even for indexed identity lookups. Under Serializable isolation these scans acquire relation-wide predicate locks, so mutations of unrelated agents can repeatedly abort one another. The shared helper discourages sequential scans only within the transaction; it does not change query results or guarantee row-only locks.[^planning]

Grant management and remote MCP attachment run this helper before their reads, inside each retried transaction. The retry wrapper retries only serialization conflicts, with bounded jittered backoff; ordinary failures still escape.[^grants][^attachment][^planning]

**What to do:** preserve transaction-local scan planning alongside bounded retries when refactoring these ownership paths. Retrying the same broad scan alone can reproduce the conflict until the retry budget is exhausted. Keep external effects outside the retried closure. This complements [transactional authorization](transactional-agent-authorization.md); see [MCP management](overview-mcp.md) and [core execution](overview-core.md).

[^planning]: src/core/serializable-retry.ts, lines 19-48.

[^grants]: src/mcp/tools/grants.ts, lines 128-138.

[^attachment]: src/mcp/tools/mcp-servers.ts, lines 447-461.
