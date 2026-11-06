---
id: errors/mcp-server-error
title: A remote tool server returned an error
summary: The MCP server answered with an HTTP error or a bad reply, or the tool reported an error; also covers invalid_arguments.
audience: operator
tags: [mcp, mcp_server_error, invalid_arguments, isError, tools/call]
appliesTo: ">=0.8.0"
---

# A remote tool server returned an error

## What happened

A call returned `mcp_server_error`. Either the server answered with an HTTP status other than 2xx (not 401 or 403), sent a reply Wardby could not read, or the tool ran and reported an error; the server's message is passed on with secret values removed. A call whose arguments were not a JSON object returns `invalid_arguments` instead.

## What to do

1. Read the message: a tool-reported error usually says what was wrong with the arguments.
2. If the HTTP status is a 5xx, retry later or ask the server's operator.
3. If the tool's input changed, `refresh_mcp_server` and review `get_mcp_server`.

See [Remote MCP servers](../mcp-servers.md).
