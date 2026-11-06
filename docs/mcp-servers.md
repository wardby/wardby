# Remote MCP servers for native agents

A native agent can call the tools of a remote MCP server. You register the
server once (its HTTPS URL plus your brokered secrets), Wardby saves the
server's tool list, and you attach an allowlisted subset of those tools to
an agent. The agent sees each tool as `<server name>__<tool name>`.

`WARDBY_MCP_SERVERS` decides who may register servers: `owners` (the
default, anyone), `admins` (registering, updating and refreshing need
`hosts:admin`) or `off` (every tool below is refused).

## Tools

| Tool                  | Who                | What it does                                                                                                       |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `register_mcp_server` | anyone (see mode)  | Registers a server from `name`, `url` (e.g. `https://mcp.example.com/mcp`) and `secretNames`; saves its tool list. |
| `update_mcp_server`   | the server's owner | Changes the URL or secret names, saves a fresh tool list and returns what changed.                                 |
| `refresh_mcp_server`  | the server's owner | Saves a fresh tool list straight away; returns added, removed and changed tools and the agents left missing tools. |
| `list_mcp_servers`    | anyone             | Your servers: id, name, host, tool count and when the tool list was saved.                                         |
| `get_mcp_server`      | the server's owner | One server with its full saved tool list.                                                                          |
| `delete_mcp_server`   | the server's owner | Deletes a server and detaches it from every agent.                                                                 |
| `attach_mcp_server`   | the agent's owner  | Lets a native agent call the named tools (`allowedTools`, exact names) with an optional `callTimeoutMs`.           |
| `detach_mcp_server`   | the agent's owner  | Removes a server's tools from an agent.                                                                            |

`get_agent` shows each attached server under `mcpServers`, with the exposed
tool names and any allowed tools the server no longer lists
(`missingTools`).

An attachment belongs to the server's owner, because the server's secrets act
for that owner. When `make_owner` gives an agent a new owner, servers the new
owner doesn't own are detached and listed under `bindingsRemoved` with
`kind: "mcp_server"`. `wardby grants adopt-public` and
`wardby grants prune-bindings` remove them the same way.
