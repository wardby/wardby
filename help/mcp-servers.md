---
id: mcp-servers
title: Remote MCP server tools for native agents
summary: Register a remote MCP server, then attach an allowlist of its tools to a native agent; credentials stay in brokered secrets.
audience: operator
tags: [mcp, mcp server, register_mcp_server, attach_mcp_server, refresh_mcp_server, WARDBY_MCP_SERVERS, brokered]
appliesTo: ">=0.8.0"
---

# Remote MCP server tools for native agents

A native agent can call tools from a remote MCP server (Streamable HTTP, HTTPS only).

1. Create a [brokered secret](brokered-secrets.md) for the server's host, for example
   `Authorization: Bearer {value}`.
2. `register_mcp_server` with a `name`, the `url` (`https://mcp.example.com/mcp`) and
   `secretNames`. Wardby saves the server's tool list.
3. `attach_mcp_server` with the agent, the server and `allowedTools` (exact names, at least one).
   The agent sees each as `<server name>__<tool name>`.
4. After the server changes its tools, `refresh_mcp_server` applies the new list at once. Allowed
   tools the server dropped show as `missingTools` in `get_agent`.

Each call has `callTimeoutMs` (default `30000`, at most `WARDBY_TOOL_MAX_TIMEOUT_MS`, and never
past the run's deadline). Results are untrusted input; the allowlist is the control. Coding agents,
stdio servers and OAuth are not supported.

`WARDBY_MCP_SERVERS` is `owners` (default), `admins` (registering needs `hosts:admin`) or `off`.

Share a server with `grant_access` (`resourceType: "mcp_server"`). `use` lets the grantee attach
it, and its tools then run with your secrets.

Errors a call can return: [`mcp_server_unreachable`](errors/mcp-server-unreachable.md),
[`mcp_server_auth_failed`](errors/mcp-server-auth-failed.md),
[`mcp_server_error`](errors/mcp-server-error.md),
[`mcp_tool_not_allowed`](errors/mcp-tool-not-allowed.md),
[`mcp_tool_removed`](errors/mcp-tool-removed.md),
[`mcp_call_timeout`](errors/mcp-call-timeout.md),
[`mcp_servers_off`](errors/mcp-servers-off.md).

Full guide: [Remote MCP servers](../docs/mcp-servers.md).
