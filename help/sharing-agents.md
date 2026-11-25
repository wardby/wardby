---
id: sharing-agents
title: Share an agent, or make it public
summary: Grant one person or everyone signed in access to an agent, including a public agent anyone can edit.
audience: operator
tags: [sharing, grant_access, public, access-control, agents]
appliesTo: ">=0.7.0"
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

Without a grant, an agent answers "not found", the same as an agent that does
not exist. The exception is a caller with `admin:view` (the `admin` or `viewer`
role), who already sees every agent in `list_agents { all: true }`: they get
"you have no access to this agent (access: none)" instead. That listing gives
them no access of their own; to read or run the agent they still need a grant
from its owner.

## Share a secret, datastore or webhook

`grant_access` also takes `resourceType: "secret"`, `"datastore"` or
`"webhook"` for one you own (or your team owns). The only level is `read`, and
`everyone` is refused: name the people it is for.

- A grantee sees that the resource exists, with its name and metadata, in
  `list_secrets`, `list_datastores` or `list_webhooks`. A secret's value is never
  shown.
- A grantee binds, changes and deletes nothing. Only the owner, or a team that
  owns it, attaches a secret or datastore to an agent, and a bound resource must
  belong to the agent's owner.
- A missing resource, and one you cannot see, both answer "not found".
  Deleting a resource drops its grants.

## Share a tool

`grant_access` with `resourceType: "tool"` shares a tool you own (or your Team
owns). Levels, lowest first:

- `read`: see the tool's name, description and time limit in `list_tools`, never
  its code.
- `use`: also attach it to your own agents (`attach_tool`) and use it in run
  hooks. The tool's code then runs in your agent with the capabilities you grant
  it, so read the owner's description and trust them first.
- `write`: adds nothing beyond `use`. Only the owner updates or deletes a tool,
  or grants access to it, and not while it is attached to someone else's agent.

`everyone` can hold at most `use`. Lowering a grant below `use`, or revoking it,
detaches the tool from every agent and run hook whose owner can no longer use
it; the owner's own agents are never touched.

## Share a budget group

`grant_access` with `resourceType: "budget_group"` shares a budget group you
own (or your Team owns). Levels, lowest first:

- `read`: see the group and its spend (`get_budget_group`, `list_budget_groups`).
- `use`: also put your own agents in it with `update_agent` and `budgetGroupId`,
  so their runs count against the group's caps.
- `write`: also rename it and change its caps (`update_budget_group`).

Only the owner deletes the group or grants access to it. `everyone` can hold at
most `use`. Lowering a grant below `use`, or revoking it, takes the group off
every agent whose owner can no longer use it; the owner's own agents are never
touched.

## Public agents

Grant `everyone` at `read` or `execute` for an agent anyone can see or run.
Grant `everyone` at `write` for an agent anyone can also edit.

Everyone-`write` is refused while the agent holds any of its owner's bindings:
secrets, datastores, repositories, sub-agents, tool capabilities, document tools
(`documentTools`), or a coding repository, so a coding agent can't be public-write. Otherwise anyone could
rewrite its prompt and use them. Detach them first, or grant `execute` instead.
The reverse holds too: `attach_secret`, `attach_datastore`, `link_repository`,
`attach_subagent`, `attach_tool` with capabilities, and `update_agent` making
it a coding agent or setting `documentTools` are refused on an agent everyone can write. Revoke or lower
the everyone grant first.

### Cap what a public-write agent can spend

Runs of a shared agent are charged to its owner. With `write`, anyone signed in
can change the agent's model, per-run budget, turns and schedule, and create
webhooks that trigger it. Before granting everyone `write`, put the agent in a
budget group (`create_budget_group`, then `update_agent` with `budgetGroupId`).
Only the owner can change
budget-group membership, so the group's limit caps total spend whatever anyone
else changes.

### After you revoke or lower the grant

- **Webhooks:** a webhook fires only while its creator can still run the
  agent. Revoking the everyone grant stops webhooks other people created;
  lowering it to `execute` keeps them firing. Use `list_webhooks` and
  `delete_webhook` to remove them; the owner can delete any webhook on the
  agent.
- **Schedule:** a schedule someone else set stays on the agent. Check it with
  `get_agent` and remove it with `disable_schedule`.
- **Prompt and settings:** edits stay. Check the prompt, model and budget with
  `get_agent`.

See [Identity and access](identity-and-access.md) for sign-in and scopes.
