---
type: overview
title: MCP management and authorization
description: Transport identity becomes scoped management calls over owned resources and explicit grants.
tags: [mcp, access, auth]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-16T06:04:47.588Z }
sources:
  - id: composition
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/mcp/index.ts#L143-L192
  - id: dispatch
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/mcp/server.ts#L288-L308
  - id: access
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/mcp/auth/access.ts#L55-L78
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/mcp/**"]
  citations:
    - id: composition
      repo: github:wardby/wardby
      path: src/mcp/index.ts
      lines: [143, 192]
      symbol: localOperatorContext / registerAllTools
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:69028d81cf6b0e38137925693148541dfd7e27829f9056d68ffbd00cbc70146c
    - id: dispatch
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [288, 308]
      symbol: factory
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:4fe5d3d2e93961fb1d044450ab050dcfe7429a5f7fc588af677dc710c05ae222
    - id: access
      repo: github:wardby/wardby
      path: src/mcp/auth/access.ts
      lines: [55, 78]
      symbol: assertAgentAccess / requireAgentAccess
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:04c8d3accf60339956706f501fbf628ae620e8f368bd93c20825f6ef4f915cbb
  confidence: high
---

MCP is the management boundary for agents, bindings, budgets, tools, secrets, schedules, documents, remote MCP server bindings and run inspection. Its composition root registers the tool modules and supplies provider and database context. Stdio uses a fixed local operator identity; HTTP calls resolve authenticated context at dispatch.[^composition][^dispatch]

A management call proceeds through these steps:

1. The transport establishes identity and the server resolves a request context.
2. The registration wrapper requires the tool's OAuth scopes and maps database errors before they reach the client.
3. The handler checks resource access separately from scopes. Agent access hides unreadable resources and distinguishes insufficient access on readable ones.
4. Mutations persist definitions and grants; execution requests enter [core dispatch](overview-core.md), while MCP tasks project the run's progress and result.[^dispatch][^access]

The area owns request context, tool registration and task presentation; durable principals, grants and task rows live in [Prisma](overview-prisma.md). Authentication adapters come from [provider seams](overview-providers.md), and transport settings come from [configuration](overview-config.md).

**What to do:** preserve independent scope and resource checks. Read the area's contracts on [transactional authorization](transactional-agent-authorization.md), [schema conversion](mcp-schema-module-boundary.md), [HTTP prompt discovery](mcp-http-prompt-discovery.md), [task cancellation](mcp-cancelled-task-precedence.md) [secret-entry replicas](secret-entry-replica-contract.md) and [Serializable predicate locks](serializable-predicate-locks.md). Operator setup belongs in [identity provider guidance](../getting-started-identity-provider.md).

[^composition]: src/mcp/index.ts, lines 143-192.

[^dispatch]: src/mcp/server.ts, lines 288-308.

[^access]: src/mcp/auth/access.ts, lines 55-78.
