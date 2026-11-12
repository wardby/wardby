---
id: errors/mcp-server-error
title: A remote tool server returned an error (mcp_server_error)
summary: The MCP server answered with an HTTP error or a bad reply, asked for something Wardby doesn't support, or the tool reported an error.
audience: operator
tags: [mcp, mcp_server_error, isError, tools/call, credentials]
appliesTo: ">=0.8.0"
---

# A remote tool server returned an error

## What happened

A call returned `mcp_server_error`. One of these happened:

- the server answered with an HTTP status other than 2xx (not 401 or 403), or sent a reply Wardby could not read;
- the server's reply carried only a request of its own (sampling, elicitation or roots) and no answer: Wardby supports none of them, so the call fails;
- the tool ran and reported an error; the server's message is passed on with secret values removed;
- the server's secrets could not be loaded (missing, not brokered, or not brokered to the server's host). The server's owner sees which secret; an agent using a server shared with its owner sees only "The MCP server's credentials can't be used; ask its owner to check it." From 0.9.12, when the owner's OAuth secret could not be refreshed just now (the provider was unreachable or busy), that agent sees "The MCP server's credentials could not be refreshed just now; try again shortly." instead: retry the call later. Earlier releases show the "can't be used" message in that case too.

## What to do

1. Read the message: a tool-reported error usually says what was wrong with the arguments.
2. If the HTTP status is a 5xx, retry later or ask the server's operator.
3. If the tool's input changed, `refresh_mcp_server` and review `get_mcp_server`.
4. For a credentials message on a shared server, ask the server's owner to check its secrets with `get_mcp_server` and `list_secrets`.

See [Remote MCP servers](../mcp-servers.md).
