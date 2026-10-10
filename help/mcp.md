---
id: mcp-access
title: Connect an MCP client
summary: Use Wardby's local stdio or protected HTTP MCP transport safely.
audience: developer
tags: [mcp, oauth, codex, claude-code]
appliesTo: >=0.2.1
---

# Connect an MCP client

For local use, `wardby quickstart` can register the local stdio MCP server with
Codex or Claude Code. Local stdio trusts the local operator.

For remote access, Wardby exposes an OAuth 2.1-protected HTTP resource server.
Run the service with `MCP_TRANSPORT=http`, set a canonical public URI, and use
the instance's configured identity-provider mode. Keep the MCP endpoint behind
your intended ingress and authentication boundary.

MCP clients use Wardby to manage agents, budgets, tools, schedules, secrets,
datastores, and runs. They do not receive the provider or GitHub App
credentials held by Wardby's trusted components.

With the existing `agents:read` scope, clients can also use `search_help` to
find bundled self-hosted guidance with fuzzy matching and `get_help_article`
to read a complete article by id. These tools use the same release-bundled,
offline catalog as `wardby help`; they expose no instance data or credentials.

See [`docs/getting-started-identity-provider.md`](../docs/getting-started-identity-provider.md)
for the supported self-hosted and delegated identity-provider setup.
