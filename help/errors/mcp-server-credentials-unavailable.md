---
id: errors/mcp-server-credentials-unavailable
title: A remote tool server's credentials can't be decrypted
summary: A brokered secret of an MCP server exists but this Wardby server can't decrypt it; check SECRET_APP_KEY.
audience: operator
tags: [mcp, mcp_server_credentials_unavailable, credentials, decrypt, SECRET_APP_KEY, register_mcp_server]
appliesTo: ">=0.8.0"
---

# A remote tool server's credentials can't be decrypted

## What happened

An agent's MCP tool call returned `mcp_server_credentials_unavailable`, or `register_mcp_server`,
`update_mcp_server` or `refresh_mcp_server` failed with it (as an HTTP 500 error). The server's
brokered secret exists, but the Wardby process that made the call could not decrypt its stored value.
Wardby did not contact the MCP server.

The usual causes:

- The Wardby processes don't share one `SECRET_APP_KEY`. The control plane, the scheduler and the
  native gateway each decrypt secrets, so a process started with another key can't read a secret
  the others saved.
- `SECRET_APP_KEY` was changed after the secret was saved.
- The stored value is damaged.

An agent that uses another owner's server through a grant sees the same code with a generic
message: "The MCP server's credentials can't be used; ask its owner to check it."

## What to do

1. Check that every Wardby process (control plane, scheduler, native gateway) gets the same
   `SECRET_APP_KEY`. Fix the one that differs and restart it.
2. If the key really changed, set the secret again with its new value (`create_secret` with the same
   name), then run `refresh_mcp_server`.
3. Operator logs carry one `warn` line per failure with `reason: "mcp_secret_decrypt_failed"`, the
   server and the secret name (never the value or the cipher's error).

A secret that is missing, not brokered, or not brokered to the server's host is an input problem
instead and returns [`mcp_server_error`](mcp-server-error.md) or a 400 error from the register,
update and refresh tools.

See [Remote MCP servers](../mcp-servers.md) and [Secrets and tools](../../docs/tool-secrets.md).
