---
id: sharing-agents
title: Share an agent, or make it public
summary: Grant one person or everyone signed in access to an agent, including a public agent anyone can edit.
audience: operator
tags: [sharing, grant_access, public, access-control, agents]
appliesTo: ">=0.6.0"
---

# Share an agent, or make it public

An agent's owner controls who else can reach it with `grant_access`,
`revoke_access` and `list_access`. Levels, lowest first:

- `read`: see the agent in `list_agents` and `get_agent`.
- `execute`: also run it (`trigger_agent`).
- `write`: also change it (`update_agent`, schedule, webhooks, tools).

The grantee is one person, `{"subject": "..."}` or `{"principalId": "..."}`,
who must have signed in once, or `"everyone"`: any principal signed in to the
MCP server.

## Public agents

Grant `everyone` at `read` or `execute` for an agent anyone can see or run.
Grant `everyone` at `write` for an agent anyone can also edit.

Everyone-`write` is refused while the agent holds any of its owner's bindings:
secrets, datastores, repositories, sub-agents or tool capabilities. Otherwise
anyone could rewrite its prompt and use them. Detach them first, or grant
`execute` instead. The reverse holds too: `attach_secret`, `attach_datastore`,
`link_repository`, `attach_subagent` and `attach_tool` with capabilities are
refused on an agent everyone can write. Revoke or lower the everyone grant
first.

See [Identity and access](identity-and-access.md) for sign-in and scopes.
