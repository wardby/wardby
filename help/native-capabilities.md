---
id: native-capabilities
title: Use native agents, tools, and data
summary: Attach scoped tools, secrets, datastores, memory, schedules, and sub-agents to a native Wardby agent.
audience: developer
tags: [agents, tools, secrets, datastores, memory, schedules, subagents]
appliesTo: >=0.2.1
---

# Use native agents, tools, and data

Native agents work through the Wardby control plane rather than a repository
checkout. Give each agent only the capabilities its job needs:

- **Tools** for approved external actions or APIs.
- **Secrets** as bindings to tools or agents; values remain in Wardby's trusted
  components rather than being returned through MCP.
- **Datastores** for scoped application data and queries.
- **Memory** for agent-owned durable context.
- **Schedules and webhooks** to start event-driven work.
- **Sub-agents** for delegated, bounded work with their own capability set.

Use a budget or shared budget group on every agent, and inspect runs before
expanding its access. An access grant is intentional delegation: use it only
when an owner permits one agent to use another resource. Creating or changing
tools, secrets, datastores, schedules, webhooks, memory, and budget groups
requires the matching MCP scope.

See [Operate agents](operating-agents.md) for run and budget management, and
[`README.md`](../README.md) for the feature overview and MCP operations.
