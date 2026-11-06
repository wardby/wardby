# Remote MCP servers for native agents

A native agent can call the tools of a remote MCP server. You register the
server once (its HTTPS URL plus your brokered secrets), Wardby saves the
server's tool list, and you attach an allowlisted subset of those tools to
an agent. The agent sees each tool as `<server name>__<tool name>`.

`WARDBY_MCP_SERVERS` decides who may register servers: `owners` (the
default, anyone), `admins` (registering, updating and refreshing need
`hosts:admin`) or `off` (every tool below is refused).

## Tools

| Tool                  | Who                   | What it does                                                                                                       |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `register_mcp_server` | anyone (see mode)     | Registers a server from `name`, `url` (e.g. `https://mcp.example.com/mcp`) and `secretNames`; saves its tool list. |
| `update_mcp_server`   | the server's owner    | Changes the URL or secret names, saves a fresh tool list and returns what changed.                                 |
| `refresh_mcp_server`  | the server's owner    | Saves a fresh tool list straight away; returns added, removed and changed tools and the agents left missing tools. |
| `list_mcp_servers`    | anyone                | Your servers and those shared with you: id, name, host, tool count, saved-at, `yours`.                             |
| `get_mcp_server`      | owner, or `read`+     | One server with its full saved tool list (secret names and URL only for the owner).                                |
| `delete_mcp_server`   | the server's owner    | Deletes a server and detaches it from every agent.                                                                 |
| `attach_mcp_server`   | agent's owner; `use`+ | Lets a native agent call the named tools (`allowedTools`, exact names) with an optional `callTimeoutMs`.           |
| `detach_mcp_server`   | the agent's owner     | Removes a server's tools from an agent.                                                                            |

`get_agent` shows each attached server under `mcpServers`: the server's name,
the allowed tools, the exposed tool names and any allowed tools the server no
longer lists (`missingTools`). Anyone with read access on the agent sees this.
It never includes URLs, secret names or values, or saved tool lists.

## Create a secret for the server

Servers are authenticated with [brokered secrets](tool-secrets.md): Wardby adds
the value to every request to the server's host and nobody, including the
model, can read it back. Create the secret, then set its broker config with
`set_secret_broker` so it is limited to the server's host. For a bearer token:

```json
{
  "hosts": ["mcp.example.com"],
  "placement": { "kind": "header", "name": "Authorization", "format": "Bearer {value}" }
}
```

A server that wants two headers needs two secrets, each with its own
placement (for example `X-Api-Key` with `format: "{value}"`, and
`X-Workspace` the same way); name both in `secretNames`. The URL itself can't
carry credentials: a username, password or fragment is refused.

## Register, read the tool list, attach

1. `register_mcp_server` with `name` (1-32 characters: lower-case letters,
   digits, `_` or `-`), `url` (`https://mcp.example.com/mcp`: HTTPS only,
   default port) and `secretNames`. Wardby calls the server's `tools/list`
   and saves the result. A secret that is missing, not brokered, or not
   brokered to the URL's host is refused.
2. `get_mcp_server` shows the saved tools: name, description, input schema and
   the server's annotations.
3. `attach_mcp_server` with the agent, the server and `allowedTools`: exact
   tool names from the saved list, at least one, no wildcards. Attaching
   replaces the agent's earlier allowlist and time limit for that server.
   Only native agents can attach a server.

The agent sees each tool as `<server name>__<tool name>`, with any character
outside letters, digits, `_` and `-` changed to `_`; the result must be at
most 64 characters. The description starts with `From MCP server <server name>: `.
Attaching is refused if the name clashes with another tool on the agent
(attached, another MCP tool, or a built-in name).

## Time limits

Each call has `callTimeoutMs` (default `30000`, set on `attach_mcp_server`).
It can't exceed `WARDBY_TOOL_MAX_TIMEOUT_MS`; a call runs with the lower of
the two, and never past the run's own deadline. `stop_run` aborts a call in
flight. A call that runs out of time returns `mcp_call_timeout` to the model
and the run goes on.

## Refreshing and changes

`refresh_mcp_server` (and `update_mcp_server`) fetch the tool list again and
apply it at once. The reply lists tools added, removed and changed
(description or schema). A removed tool that an agent allows is dropped from
that agent's runs and shows under `missingTools` in `get_agent`; nothing
needs re-attaching if the server brings it back and you refresh again. A
tool the server newly adds is not available to any agent until you attach it.

## What a call does

Each call opens its own session: `initialize`, `notifications/initialized`,
`tools/call`, then a `DELETE` to end it. Wardby checks on every call that
the tool is still attached and still in the saved list. Text returned to the
model is cut at 100,000 characters, with a note. Anything the server sends
that isn't an answer to Wardby's request (sampling, elicitation, roots,
notifications) is ignored or answered "not supported". One log line per call
records the server id, tool, outcome, duration and result size, never the
arguments or the response. Secret values are removed from results, errors and
logs.

## Not supported

stdio servers, OAuth to a server (use a header secret), MCP resources,
prompts and sampling, and coding agents (a coding run doesn't load attached
servers or any MCP configuration yet).

## Trust

A server's results are untrusted input to the model, like any tool result. The
allowlist is the control: attach only the tools an agent needs. A server's
annotations (read-only, destructive and so on) are hints from the server, not
something Wardby enforces.

## Sharing a server

Share a server you own with `grant_access` (`resourceType: "mcp_server"`, a
principal or `everyone`, level `read`, `use` or `write`; `everyone` is capped
at `use`). `read` lets the grantee see the server and its tool list; `use`
also lets them attach it to their own agents. The server's tools then run with
your brokered secrets, so grant `use` only to people you trust with them.
`write` allows nothing beyond `use`: only the owner updates, refreshes,
deletes or re-grants a server.

`delete_mcp_server` removes the server's tools from every agent attached to
it, including other owners' agents that use it through a grant, and removes
its grants. Revoking a grant stops new attachments but doesn't remove ones
already made: the grantee's agents keep the server until it is detached.

An attachment acts with the server owner's secrets. When `make_owner` gives an
agent a new owner, servers the new owner neither owns nor holds `use` on are
detached and listed under `bindingsRemoved` with `kind: "mcp_server"`.
`wardby grants adopt-public` and `wardby grants prune-bindings` remove them the
same way. An agent that holds an MCP server can't be made writable by
everyone.

## Troubleshooting

A failed call returns `{"error": "<code>", "message": "..."}` to the model;
the run goes on.

| Code                                                                 | Meaning                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`mcp_servers_off`](../help/errors/mcp-servers-off.md)               | `WARDBY_MCP_SERVERS=off`.                                             |
| [`mcp_server_unreachable`](../help/errors/mcp-server-unreachable.md) | Wardby couldn't connect to the server.                                |
| [`mcp_server_auth_failed`](../help/errors/mcp-server-auth-failed.md) | The server answered 401 or 403.                                       |
| [`mcp_server_error`](../help/errors/mcp-server-error.md)             | Another HTTP error, a malformed reply, or the tool reported an error. |
| [`mcp_tool_not_allowed`](../help/errors/mcp-tool-not-allowed.md)     | The server was detached or the tool left the allowlist.               |
| [`mcp_tool_removed`](../help/errors/mcp-tool-removed.md)             | The server no longer lists the tool.                                  |
| [`mcp_call_timeout`](../help/errors/mcp-call-timeout.md)             | The call hit its time limit or the run was stopped.                   |

See also [Secrets and tools](tool-secrets.md) and
[Remote MCP servers](security-deployment.md#remote-mcp-servers).
