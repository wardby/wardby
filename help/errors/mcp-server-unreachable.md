---
id: errors/mcp-server-unreachable
title: A remote tool server could not be reached (mcp_server_unreachable)
summary: Wardby could not connect to a remote MCP server; check the URL, the server and its network path.
audience: operator
tags: [mcp, mcp_server_unreachable, unreachable, register_mcp_server, update_mcp_server]
appliesTo: ">=0.8.0"
---

# A remote tool server could not be reached

## What happened

An agent's MCP tool call returned `mcp_server_unreachable`, or `register_mcp_server` / `refresh_mcp_server` failed with it. Wardby could not open a connection to the server's URL (DNS, TLS, refused or reset connection). Only this call failed.

## What to do

1. Check the URL with `get_mcp_server` (the owner sees it) and that the server is up.
2. Check that Wardby's network can reach the host over HTTPS on the default port.
3. Fix the URL with `update_mcp_server`, then `refresh_mcp_server`.

See [Remote MCP servers](../mcp-servers.md).
