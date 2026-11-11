---
type: overview
title: MCP management and authorization
description: Transport identity becomes scoped management calls over owned resources and explicit grants.
tags: [mcp, access, auth]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-02T06:04:39.135Z }
sources:
  - id: composition
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/index.ts#L118-L175
  - id: dispatch
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/server.ts#L282-L302
  - id: access
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/mcp/auth/access.ts#L55-L78
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/mcp/**"]
  citations:
    - id: composition
      repo: github:wardby/wardby
      path: src/mcp/index.ts
      lines: [118, 175]
      symbol: localOperatorContext / registerAllTools
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:3efbdb7f5f323e05b8baddab05ded6c84faf40d3f86e1be9b948a990bf4f97ef
    - id: dispatch
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [282, 302]
      symbol: factory
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:4fe5d3d2e93961fb1d044450ab050dcfe7429a5f7fc588af677dc710c05ae222
    - id: access
      repo: github:wardby/wardby
      path: src/mcp/auth/access.ts
      lines: [55, 78]
      symbol: assertAgentAccess / requireAgentAccess
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
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

**What to do:** preserve independent scope and resource checks and [transactional exclusion between public write and bindings](public-write-binding-transaction.md). Read the area's contracts on [transactional authorization](transactional-agent-authorization.md), [schema conversion](mcp-schema-module-boundary.md), [HTTP prompt discovery](mcp-http-prompt-discovery.md), [task cancellation](mcp-cancelled-task-precedence.md) and [secret-entry replicas](secret-entry-replica-contract.md). Operator setup belongs in [identity provider guidance](../getting-started-identity-provider.md).

[^composition]: src/mcp/index.ts, lines 118-175.

[^dispatch]: src/mcp/server.ts, lines 282-302.

[^access]: src/mcp/auth/access.ts, lines 55-78.
