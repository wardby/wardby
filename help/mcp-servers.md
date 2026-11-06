---
id: mcp-servers
title: Remote MCP server tools for native and coding agents
summary: Register a remote MCP server, then attach an allowlist of its tools to a native, Claude Code or Codex agent; credentials stay in brokered secrets.
audience: operator
tags: [mcp, mcp server, coding-agent, codex, register_mcp_server, attach_mcp_server, readOnlyHint, WARDBY_MCP_SERVERS]
appliesTo: ">=0.8.0"
---

# Remote MCP server tools for native and coding agents

A native, Claude Code or Codex agent can call tools from a remote MCP server (Streamable HTTP, HTTPS only).

1. Create a [brokered secret](brokered-secrets.md) for the server's host, for example
   `Authorization: Bearer {value}`.
2. `register_mcp_server` with a `name`, the `url` (`https://mcp.example.com/mcp`) and
   `secretNames`. Wardby saves the server's tool list.
3. `attach_mcp_server` with the agent, the server and `allowedTools` (exact names, at least one).
   The agent sees each as `<server name>__<tool name>`.
4. After the server changes its tools, `refresh_mcp_server` applies the new list at once. Allowed
   tools the server dropped show as `missingTools` in `get_agent`.

Each call has `callTimeoutMs` (default `30000`, at most `WARDBY_TOOL_MAX_TIMEOUT_MS`, and never
past the run's deadline). Results are untrusted input; the allowlist is the control. stdio servers
and OAuth are not supported.

`WARDBY_MCP_SERVERS` is `owners` (default), `admins` (registering needs `hosts:admin`) or `off`
(only `detach_mcp_server` and `delete_mcp_server` still work, for cleanup).

Each call opens a fresh MCP session, so a server that keeps state between calls in one session
won't see it. Arguments that aren't a JSON object return `invalid_arguments`.

## Coding agents

`attach_mcp_server` also takes a Claude Code or Codex agent. Its run reaches the tools only through
the coding proxy and the native gateway; the worker never sees the server's URL or secrets.

- Claude Code agents see each tool as `mcp__wardby_mcp__<server name>__<tool name>` and may use any
  allowed tool.
- Codex agents may use only tools the server marks `readOnlyHint: true`. Wardby checks this when
  you attach, when a run loads and on every call. Repository code in a Codex run can read the run's
  MCP token, so a Codex agent must not be given tools that change things. `readOnlyHint` is the
  server's claim, which Wardby can't verify, so the allowlist stays your control.
- A run may make `WARDBY_MCP_MAX_CALLS_PER_RUN` calls (default `100`, failed calls count); more are
  refused with [`mcp_call_limit`](errors/mcp-call-limit.md).
- The proxy needs `WARDBY_MCP_GATEWAY_URL`. Without it coding agents get no MCP tools
  ([`mcp_unavailable`](errors/mcp-unavailable.md)).
- MCP for coding agents needs this release's Claude worker image and a new Codex driver image.
  Older images get no MCP tools, and runs don't fail.
- A repository's MCP configuration is still never loaded. Codex models that use tool search
  aren't supported: the proxy refuses their requests (`openai_tool_not_allowed`), MCP or not, so
  those runs fail.
- Switching an agent to Codex with `update_agent` keeps its attachments, but tools not marked
  read-only won't reach Codex runs; the result's `warnings` names them.
- The proxy gives up on a coding run's MCP call after 5 minutes, whatever
  `WARDBY_TOOL_MAX_TIMEOUT_MS` says ([`mcp_unavailable`](errors/mcp-unavailable.md)).

Share a server with `grant_access` (`resourceType: "mcp_server"`; needs the `agents:write` scope,
registering needs `tools:write`). `use` lets the grantee attach it, and its tools then run with your
secrets. Revoking the grant, or lowering it to `read`, detaches the server from the grantee's agents
at once, and their runs' next call is refused with `mcp_tool_not_allowed`.

Errors a call can return: [`mcp_server_unreachable`](errors/mcp-server-unreachable.md),
[`mcp_server_auth_failed`](errors/mcp-server-auth-failed.md),
[`mcp_server_error`](errors/mcp-server-error.md),
[`mcp_tool_not_allowed`](errors/mcp-tool-not-allowed.md),
[`mcp_tool_removed`](errors/mcp-tool-removed.md),
[`mcp_call_timeout`](errors/mcp-call-timeout.md),
[`mcp_servers_off`](errors/mcp-servers-off.md), and for coding agents
[`mcp_call_limit`](errors/mcp-call-limit.md) and [`mcp_unavailable`](errors/mcp-unavailable.md).

Full guide: [Remote MCP servers](../docs/mcp-servers.md).
