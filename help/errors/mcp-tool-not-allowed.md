---
id: errors/mcp-tool-not-allowed
title: A remote tool is no longer allowed (mcp_tool_not_allowed)
summary: The agent's MCP server was detached, the tool left its allowlist, or the agent's owner lost use access to a shared server.
audience: operator
tags: [mcp, mcp_tool_not_allowed, attach_mcp_server, detach_mcp_server, allowedTools, revoke_access]
appliesTo: ">=0.8.0"
---

# A remote tool is no longer allowed

## What happened

A call returned `mcp_tool_not_allowed`. Wardby checks the agent's attachment on every call, and since the run began one of these happened:

- the server was detached, or the tool left `allowedTools`;
- the server's owner deleted the server;
- the server is shared with the agent's owner, and its owner revoked that grant or lowered it to `read`. The agent's owner must own the server or hold `use` on it; when that ends, Wardby detaches the server from the agent too.

## What to do

1. Check `get_agent` for `mcpServers`.
2. Re-attach with `attach_mcp_server` and include the tool in `allowedTools`. For a shared server, ask its owner for `use` again first.
3. A run that started before the change still lists the tool, but every call re-checks the attachment, so the call is refused with this error.

See [Remote MCP servers](../mcp-servers.md).
