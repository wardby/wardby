---
type: Architecture Pattern
title: MCP server
description: Management surface for wardby over MCP, stdio locally and OAuth 2.1 resource server over HTTP.
tags: [mcp, auth, api]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: server-ts
    resource: /src/mcp/server.ts
---

# Transports and auth

* **stdio:** one fixed local principal for the whole connection; the local
  operator is trusted.
* **HTTP:** an OAuth 2.1 resource server. Caller identity travels as the SDK's
  `AuthInfo.extra.principal`, and each tool enforces scope via
  `requireScope`.[^server-ts] Auth is self-hosted or delegated to your IdP
  (`src/providers/auth/`).

`server.ts` accumulates `ToolSpec`s and exposes a side-effect-free
`McpServerFactory`; the transports build a fresh `McpServer` per request or
connection using the official SDK rather than hand-rolled dispatch.

# Tools

Management tools live in `src/mcp/tools/` (agents, tools, schedules, budget
groups, secrets, datastores, webhooks, runs, models, help). `search_help` and
`get_help_article` serve the bundled `help/` articles (see
[docs and help check](/playbooks/docs-and-help-check.md)).

[^server-ts]: src/mcp/server.ts
