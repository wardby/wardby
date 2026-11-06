---
id: errors/mcp-tool-removed
title: A remote tool is no longer on the server
summary: The server's saved tool list no longer has the tool; check missingTools in get_agent.
audience: operator
tags: [mcp, mcp_tool_removed, missingTools, refresh_mcp_server]
appliesTo: ">=0.8.0"
---

# A remote tool is no longer on the server

## What happened

A call returned `mcp_tool_removed`. After a `refresh_mcp_server`, the server's saved list no longer includes a tool the agent allows, so calls to it are refused. `get_agent` lists it under `missingTools`.

## What to do

1. Check `get_mcp_server` for the tool's current name; servers sometimes rename tools.
2. Re-attach with `attach_mcp_server` using the new name.
3. If the tool is back on the server, `refresh_mcp_server` makes it callable again.

See [Remote MCP servers](../mcp-servers.md).
