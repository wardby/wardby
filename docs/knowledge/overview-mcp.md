---
type: overview
title: MCP management and authorization
description: Transport identity becomes scoped management calls over owned resources and explicit grants.
tags: [mcp, access, auth]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-23T06:06:02.167Z }
sources:
  - id: composition
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/index.ts#L147-L215
  - id: dispatch
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/server.ts#L294-L314
  - id: access
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/auth/access.ts#L56-L79
  - id: standing
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/auth/resource-server.ts#L233-L245
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/mcp/**"]
  citations:
    - id: composition
      repo: github:wardby/wardby
      path: src/mcp/index.ts
      lines: [147, 215]
      symbol: localOperatorContext / registerAllTools
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:1dee7a3c3e306b48d54af2db76819424f18a8f9c5bc1f0160cc511f1ec92fae3
    - id: dispatch
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [294, 314]
      symbol: factory
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:4fe5d3d2e93961fb1d044450ab050dcfe7429a5f7fc588af677dc710c05ae222
    - id: access
      repo: github:wardby/wardby
      path: src/mcp/auth/access.ts
      lines: [56, 79]
      symbol: assertAgentAccess / requireAgentAccess
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:04c8d3accf60339956706f501fbf628ae620e8f368bd93c20825f6ef4f915cbb
    - id: standing
      repo: github:wardby/wardby
      path: src/mcp/auth/resource-server.ts
      lines: [233, 245]
      symbol: resolveStanding
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:629833c90da4a1b923435aea5789b73884d487cdf4c8c0356f514da6c14cd486
  confidence: high
---

MCP is the management boundary for agents, bindings, budgets, tools, secrets, schedules, teams, documents and run inspection. Its composition root registers the tool modules and supplies provider and database context. Stdio uses a fixed local operator identity; HTTP calls resolve authenticated context at dispatch.[^composition][^dispatch]

A management call proceeds through these steps:

1. For HTTP calls, the transport establishes identity and resolves current team membership and roles; the server carries that standing into the request context.[^standing]
2. The registration wrapper requires the tool's OAuth scopes and maps database errors before they reach the client.
3. The handler checks resource access separately from scopes. Agent access hides unreadable resources and distinguishes insufficient access on readable ones.
4. Mutations persist definitions and grants; execution requests enter [core dispatch](overview-core.md), while MCP tasks project the run's progress and result.[^dispatch][^access]

The area owns request context, tool registration and task presentation; durable principals, grants and task rows live in [Prisma](overview-prisma.md). Authentication adapters come from [provider seams](overview-providers.md), and transport settings come from [configuration](overview-config.md).

**What to do:** preserve independent scope and resource checks. Read the area's contracts on [transactional authorization](transactional-agent-authorization.md), [schema conversion](mcp-schema-module-boundary.md), [HTTP prompt discovery](mcp-http-prompt-discovery.md), [task cancellation](mcp-cancelled-task-precedence.md), [secret-entry replicas](secret-entry-replica-contract.md) and [secret-entry generation retention](secret-entry-generation-retention.md). Operator setup belongs in [identity provider guidance](../getting-started-identity-provider.md).

[^composition]: src/mcp/index.ts, lines 147-215.

[^dispatch]: src/mcp/server.ts, lines 294-314.

[^access]: src/mcp/auth/access.ts, lines 56-79.

[^standing]: src/mcp/auth/resource-server.ts, lines 233-245.
