---
id: errors/mcp-servers-off
title: Remote tool servers are turned off
summary: WARDBY_MCP_SERVERS=off: MCP server tools are refused and attached servers are left out of runs.
audience: operator
tags: [mcp, mcp_servers_off, WARDBY_MCP_SERVERS, off, admins]
appliesTo: ">=0.8.0"
---

# Remote tool servers are turned off

## What happened

The Wardby MCP-server tools answered `mcp_servers_off` (403), or a run's MCP call did. The server has `WARDBY_MCP_SERVERS=off`. Attached servers' tools are left out of new runs.

## What to do

1. Ask the operator to set `WARDBY_MCP_SERVERS` to `owners` or `admins` and restart.
2. With `admins`, registering, updating and refreshing need `hosts:admin`.

See [Remote MCP servers](../mcp-servers.md).
