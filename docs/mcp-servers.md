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

`get_agent` shows each attached server under `mcpServers`, with the exposed
tool names and any allowed tools the server no longer lists
(`missingTools`).

## Sharing a server

Share a server you own with `grant_access` (`resourceType: "mcp_server"`, a
principal or `everyone`, level `read`, `use` or `write`; `everyone` is capped
at `use`). `read` lets the grantee see the server and its tool list; `use`
also lets them attach it to their own agents. The server's tools then run with
your brokered secrets, so grant `use` only to people you trust with them.
`write` allows nothing beyond `use`: only the owner updates, refreshes, deletes or re-grants a server; deleting it also
removes its grants. Revoking a grant stops new attachments but doesn't remove
ones already made: the grantee's agents keep the server until it is detached.

An attachment acts with the server owner's secrets. When `make_owner` gives an
agent a new owner, servers the new owner neither owns nor holds `use` on are
detached and listed under `bindingsRemoved` with `kind: "mcp_server"`.
`wardby grants adopt-public` and `wardby grants prune-bindings` remove them the
same way. An agent that holds an MCP server can't be made writable by
everyone.
