---
type: pitfall
title: Serializable authorization needs narrow predicate locks
description: Sequential scans can make unrelated ownership and grant mutations repeatedly conflict on small tables.
tags: [access, transactions, concurrency]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-16T06:05:14.675Z }
sources:
  - id: plans
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/core/serializable-retry.ts#L19-L47
  - id: grants
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/mcp/tools/grants.ts#L138-L154
  - id: attachment
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/mcp/tools/mcp-servers.ts#L455-L471
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    [
      "src/core/serializable-retry.ts",
      "src/mcp/tools/grants.ts",
      "src/mcp/tools/mcp-servers.ts",
      "src/mcp/tools/agents.ts",
    ]
  citations:
    - id: plans
      repo: github:wardby/wardby
      path: src/core/serializable-retry.ts
      lines: [19, 47]
      symbol: preferIndexScans / withSerializableRetry
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:0549784d45507c6748a39ccf458d33c4c67fba57bc06746cadbe429998d84e6f
    - id: grants
      repo: github:wardby/wardby
      path: src/mcp/tools/grants.ts
      lines: [138, 154]
      symbol: inSerializable
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:a4e727b39bd039c0372e02da14e7c88ba1eb624d0c0a9461a7bf7a5b006cad25
    - id: attachment
      repo: github:wardby/wardby
      path: src/mcp/tools/mcp-servers.ts
      lines: [455, 471]
      symbol: attach_mcp_server
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:71dd0f799cbc5885462c1842f69879b796deaefedb2203e75289fcb1cab02c21
  confidence: high
---

Serializable authorization can conflict even when two mutations name different agents. On small tables PostgreSQL may choose a sequential scan for an indexed lookup, taking a relation-wide predicate lock. Repeating the transaction alone can reproduce the same conflict. The shared helper uses transaction-local scan planning to narrow those reads and bounded retries for recognized conflicts.[^plans]

Grant mutations and remote MCP attachment call the planning helper inside each transaction attempt, before authorization reads. This complements [transactional agent authorization](transactional-agent-authorization.md): sharing the transaction establishes correctness, while narrowing predicate locks prevents unrelated actions from repeatedly blocking progress.[^grants][^attachment]

**What to do:** preserve both helpers when moving these mutations. Apply the planning setting inside every retry's transaction, and keep non-database effects outside retryable work; an aborted attempt can execute again. See [MCP management](overview-mcp.md) and [core execution](overview-core.md).

[^plans]: src/core/serializable-retry.ts, lines 19-47.

[^grants]: src/mcp/tools/grants.ts, lines 138-154.

[^attachment]: src/mcp/tools/mcp-servers.ts, lines 455-471.
