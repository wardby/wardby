---
type: overview
title: MCP management and authorization
description: Transport identity becomes scoped management calls over owned resources and explicit grants.
tags: [mcp, access, auth]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:21:57.208Z }
sources:
  - id: composition
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/mcp/index.ts#L109-L167
  - id: dispatch
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/mcp/server.ts#L256-L276
  - id: access
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/mcp/auth/access.ts#L47-L70
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/mcp/**"]
  citations:
    - id: composition
      repo: github:wardby/wardby
      path: src/mcp/index.ts
      lines: [109, 167]
      symbol: localOperatorContext / registerAllTools
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:6aa95fcc8cdc1954cd86a19e435870c3b23f5c4f0ec6d003839181c5e67c50cf
    - id: dispatch
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [256, 276]
      symbol: factory
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:4fe5d3d2e93961fb1d044450ab050dcfe7429a5f7fc588af677dc710c05ae222
    - id: access
      repo: github:wardby/wardby
      path: src/mcp/auth/access.ts
      lines: [47, 70]
      symbol: assertAgentAccess / requireAgentAccess
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:04c8d3accf60339956706f501fbf628ae620e8f368bd93c20825f6ef4f915cbb
  confidence: high
---

MCP is the management boundary for agents, bindings, budgets, tools, secrets, schedules and run inspection. Its composition root registers the tool modules and supplies provider and database context. Stdio uses a fixed local operator identity; HTTP calls resolve authenticated context at dispatch.[^composition][^dispatch]

A management call proceeds through these steps:

1. The transport establishes identity and the server resolves a request context.
2. The registration wrapper requires the tool's OAuth scopes and maps database errors before they reach the client.
3. The handler checks resource access separately from scopes. Agent access hides unreadable resources and distinguishes insufficient access on readable ones.
4. Mutations persist definitions and grants; execution requests enter [core dispatch](overview-core.md), while MCP tasks project the run's progress and result.[^dispatch][^access]

The area owns request context, tool registration and task presentation; durable principals, grants and task rows live in [Prisma](overview-prisma.md). Authentication adapters come from [provider seams](overview-providers.md), and transport settings come from [configuration](overview-config.md).

**What to do:** preserve independent scope and resource checks. Read the area's contracts on [transactional authorization](transactional-agent-authorization.md), [schema conversion](mcp-schema-module-boundary.md), [HTTP prompt discovery](mcp-http-prompt-discovery.md), [task cancellation](mcp-cancelled-task-precedence.md) and [secret-entry replicas](secret-entry-replica-contract.md). Operator setup belongs in [identity provider guidance](../getting-started-identity-provider.md).

[^composition]: src/mcp/index.ts, lines 109-167.

[^dispatch]: src/mcp/server.ts, lines 256-276.

[^access]: src/mcp/auth/access.ts, lines 47-70.
