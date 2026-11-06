---
id: errors/mcp-call-timeout
title: A remote tool call ran out of time (mcp_call_timeout)
summary: A remote tool call hit its callTimeoutMs or the run's deadline, or was stopped.
audience: operator
tags: [mcp, mcp_call_timeout, callTimeoutMs, timeout, stop_run, WARDBY_TOOL_MAX_TIMEOUT_MS]
appliesTo: ">=0.8.0"
---

# A remote tool call ran out of time

## What happened

A call returned `mcp_call_timeout`: the server did not answer within the call's limit, the run's own time limit was reached, or `stop_run` stopped the call. Only this call failed.

## What to do

1. If the server is slow, raise `callTimeoutMs` with `attach_mcp_server` (default `30000`).
2. The limit can't exceed `WARDBY_TOOL_MAX_TIMEOUT_MS`; ask the operator to raise that if needed.
3. A call is also cut to the run's deadline; give the agent a longer run time if needed.

See [Remote MCP servers](../mcp-servers.md).
