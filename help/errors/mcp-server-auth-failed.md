---
id: errors/mcp-server-auth-failed
title: A remote tool server refused the credentials (mcp_server_auth_failed)
summary: The MCP server answered 401 or 403; fix the brokered secret or its placement.
audience: operator
tags: [mcp, oauth, reauth, mcp_server_auth_failed, 401, 403, brokered, set_secret_broker]
appliesTo: ">=0.8.0"
---

# A remote tool server refused the credentials

## What happened

A call, or a register or refresh, failed with `mcp_server_auth_failed`: the server answered HTTP 401 or 403 to the credentials Wardby sent.

## What to do

1. Check that the token behind the server's `secretNames` is current and has access to the tool.
2. Check the secret's placement with `set_secret_broker`, for example header `Authorization` with format `Bearer {value}`.
3. If the server's secret is an OAuth secret, connect it again: `create_secret` with `oauth` under the same name (see the secret_reauth_required error and the oauth-secrets help article).
4. Update the secret, then `refresh_mcp_server` to confirm. Secret values are never shown in the error.

See [Remote MCP servers](../mcp-servers.md).
