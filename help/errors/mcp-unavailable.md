---
id: errors/mcp-unavailable
title: Remote MCP tools are unavailable to a coding run (mcp_unavailable)
summary: The coding proxy's MCP route has no native gateway to forward to, or could not reach it, so coding agents get no remote MCP tools.
audience: operator
tags: [mcp, mcp_unavailable, WARDBY_MCP_GATEWAY_URL, coding proxy, native gateway, coding agent]
appliesTo: ">=0.8.0"
---

# Remote MCP tools are unavailable to a coding run

## What happened

The coding proxy's `/mcp` route answered `503` or `502` with `mcp_unavailable`. A coding worker reaches its MCP tools only through that route, which forwards to the native gateway. It fails in one of two ways:

- `WARDBY_MCP_GATEWAY_URL` is not set on the proxy (`503`). The coding agent then runs without MCP tools; the run does not fail.
- The gateway could not be reached, timed out or answered too much (`502`). Only that request fails.

## What to do

1. Set `WARDBY_MCP_GATEWAY_URL` on the coding proxy to the native gateway's base URL, for example `http://<gateway host>:<port>`. The kind and GKE manifests set it to the in-cluster gateway.
2. Check that the native gateway is running and that the proxy's network policy allows it to reach the gateway's HTTP port.
3. Restart the proxy after changing the variable. An invalid value stops start-up.

See [Remote MCP servers for coding agents](../../docs/mcp-servers.md#coding-agents).
