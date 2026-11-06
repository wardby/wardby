---
id: errors/mcp-tool-not-allowed
title: A remote tool is no longer allowed
summary: The agent's MCP server was detached or the tool was taken off its allowlist while the run was going.
audience: operator
tags: [mcp, mcp_tool_not_allowed, attach_mcp_server, detach_mcp_server, allowedTools]
appliesTo: ">=0.8.0"
---

# A remote tool is no longer allowed

## What happened

A call returned `mcp_tool_not_allowed`. Wardby checks the agent's attachment on every call, and the server had been detached, or the tool left `allowedTools`, since the run began (or the server's owner deleted the server).

## What to do

1. Check `get_agent` for `mcpServers`.
2. Re-attach with `attach_mcp_server` and include the tool in `allowedTools`.
3. A run that started before the change keeps seeing the old tool until it ends.

See [Remote MCP servers](../mcp-servers.md).
