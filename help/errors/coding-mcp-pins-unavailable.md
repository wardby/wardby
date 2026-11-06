---
id: errors/coding-mcp-pins-unavailable
title: A coding run failed before launch because its MCP tools could not be read
summary: The run failed with coding_failure_mcp_pins_unavailable because wardby could not read the agent's MCP server attachments when it launched the run.
audience: operator
tags: [error, mcp, coding-agents, coding_failure_mcp_pins_unavailable, coding_mcp_pins_unavailable]
appliesTo: ">=0.8.0"
---

# A coding run failed before launch because its MCP tools could not be read

## What happened

The run's error starts with `coding_failure_mcp_pins_unavailable`, followed by
a diagnostic id. When wardby launches a coding run, it reads the MCP server
tools attached to the agent and fixes them for that run. That read failed, so
wardby failed the run rather than launch it without the tools it expected.
Nothing was launched, so the run made no changes.

The run's error contains only the code and the diagnostic id. The control
plane log has the real cause at `warn`, under the same diagnostic id, with
the internal code `coding_mcp_pins_unavailable`.

## What to do

1. Search the control plane log for the diagnostic id. The cause is usually
   the database: a lost connection, a timeout, or a migration that has not
   been applied.
2. Fix the database problem, then trigger the agent again. A run that hit a
   brief database outage usually works the next time.
3. If it keeps happening and you don't need MCP tools on this agent, detach
   its MCP servers with `detach_mcp_server`, or turn MCP servers off with
   `WARDBY_MCP_SERVERS=off`. Either way, the run no longer reads them.

See [Remote MCP servers for coding agents](../../docs/mcp-servers.md#coding-agents).
