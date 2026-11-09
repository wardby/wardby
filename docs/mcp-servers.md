# Remote MCP servers for native and coding agents

A native, Claude Code or Codex agent can call the tools of a remote MCP server. You register the
server once (its HTTPS URL plus your brokered secrets), Wardby saves the
server's tool list, and you attach an allowlisted subset of those tools to
an agent. A native agent sees each tool as `<server name>__<tool name>`; coding agents see
them as described in [Coding agents](#coding-agents).

`WARDBY_MCP_SERVERS` decides who may register servers: `owners` (the
default, anyone), `admins` (registering, updating and refreshing need
`hosts:admin`) or `off` (every tool below is refused except
`detach_mcp_server` and `delete_mcp_server`, so cleanup stays possible, and
attached servers' tools are left out of runs).

The tools below need the `tools:write` scope to change servers and
attachments and `agents:read` to list and get them.

## Tools

| Tool                  | Who                   | What it does                                                                                                       |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `register_mcp_server` | anyone (see mode)     | Registers a server from `name`, `url` (e.g. `https://mcp.example.com/mcp`) and `secretNames`; saves its tool list. |
| `update_mcp_server`   | the server's owner    | Changes the URL or secret names, saves a fresh tool list and returns what changed.                                 |
| `refresh_mcp_server`  | the server's owner    | Saves a fresh tool list straight away; returns added, removed and changed tools and the agents left missing tools. |
| `list_mcp_servers`    | anyone                | Your servers and those shared with you: id, name, host, tool count, saved-at, `yours`.                             |
| `get_mcp_server`      | owner, or `read`+     | One server with its full saved tool list (secret names and URL only for the owner).                                |
| `delete_mcp_server`   | the server's owner    | Deletes a server and detaches it from every agent. Works when the mode is `off`.                                   |
| `attach_mcp_server`   | agent's owner; `use`+ | Lets a native or coding agent call the named tools (`allowedTools`, exact names) with an optional `callTimeoutMs`. |
| `detach_mcp_server`   | the agent's owner     | Removes a server's tools from an agent. Works when the mode is `off`.                                              |

`get_agent` shows each attached server under `mcpServers`: the server's `serverId`
and name, the allowed tools, `callTimeoutMs`, the exposed tool names and any allowed tools the server no
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
`X-Workspace` the same way); name both in `secretNames` (at most 8 names, each up to 1024 characters). The URL itself can't
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
   Native, Claude Code and Codex agents can attach a server (see [Coding agents](#coding-agents)).

The agent sees each tool as `<server name>__<tool name>`, with any character
outside letters, digits, `_` and `-` changed to `_`; the result must be at
most 64 characters. The description starts with `From MCP server <server name>: `.
Attaching is refused if the name clashes with another tool on the agent
(attached, another MCP tool, or a built-in name).

## Coding agents

A Claude Code or Codex agent can use attached servers too. Attach them the same way, with
`attach_mcp_server`. The tools reach the run like this:

1. The worker calls the coding proxy's `/mcp` route with a per-run MCP token (`rmt_…`, in the
   worker's `WARDBY_MCP_TOKEN`). Workers still reach only the proxy.
2. The proxy forwards the request to the native gateway's `/coding-mcp` route. The proxy never sees
   a server's URL or secrets. The gateway checks the token again, checks the live attachment and
   runs the call, and removes secret values from the result before it leaves.

The token belongs to one run: it works only on `/mcp`, only while the run is active and before its
deadline, and only its hash is stored.

- **Claude Code agents** see each tool as `mcp__wardby_mcp__<server name>__<tool name>` and may use
  any allowed tool. The 64-character limit on `<server name>__<tool name>` is the same as for
  native agents; the prefix adds no other limit.
- **Codex agents may use only tools the server marks `readOnlyHint: true`.** Wardby enforces this
  when you attach (an allowlist with another tool is refused), when a run loads its tools (a tool
  whose saved annotations no longer say read-only, for example after `refresh_mcp_server`, is left
  out) and on every call. The reason is that repository code running in a Codex run can read the
  run's MCP token, so only tools that don't change anything are safe to give it. `readOnlyHint` is
  the server's own claim, which Wardby can't verify. The allowlist stays your control: allow only
  tools you trust to be read-only.

  A run follows the provider it was started with, even if the agent's provider changes before the
  run launches. A coding agent with no coding profile is treated as Codex when you attach.

- **Switching an agent to Codex.** When `update_agent` makes an agent a Codex agent (changing
  `codingProfile.provider` to `codex`, or making a native agent a coding agent, which uses Codex by
  default) and some of its attached tools aren't marked read-only, the change still goes ahead and
  the result's `warnings` names those tools: "These MCP tools aren't read-only and won't be
  available to Codex runs: …". They stay attached but Codex runs don't get them. Detach them, or
  re-attach the server with only read-only tools, to remove the warning's cause.
- **Call limit.** A run may make `WARDBY_MCP_MAX_CALLS_PER_RUN` calls (default `100`). Every call
  counts, whatever its outcome. Past the limit a call returns
  [`mcp_call_limit`](../help/errors/mcp-call-limit.md); the run goes on.
- **Proxy setting.** The coding proxy needs `WARDBY_MCP_GATEWAY_URL`, the native gateway's base URL
  (the kind and GKE manifests set it). Without it `/mcp` answers `503` with
  [`mcp_unavailable`](../help/errors/mcp-unavailable.md) and coding agents get no MCP tools. See
  [Remote MCP servers](security-deployment.md#remote-mcp-servers) for the variables.
- **Low-power mode (0.9.0 and later).** With `WARDBY_LOW_POWER=1`, a coding run with MCP tools wakes the native
  gateway as well as the coding proxy before its worker launches (both at once), and the gateway
  stays awake while any such run is pending or running, or finished within the idle window. Those
  runs appear in the gateway's `blockers` in `power_status`, and `power_sleep` refuses to sleep the
  gateway while they are pending or running. If the gateway doesn't wake in time the run fails before
  launch with
  [`coding_failure_mcp_gateway_unavailable`](../help/errors/coding-mcp-gateway-unavailable.md),
  rather than start without its MCP tools. Runs without MCP tools don't wake the gateway. See
  [Low-power mode](getting-started-gke.md#low-power-mode).
- **Worker images.** MCP for coding agents needs this release's Claude worker image and a new Codex
  driver image. An older image ignores the token and the agent gets no MCP tools; the run does not
  fail. Update the images together with the server.
- **Repository configuration.** A repository's own MCP configuration (such as `.mcp.json`) is still
  never loaded; the attached servers are the only MCP tools a coding run has.
- **Codex models that use tool search** load MCP tools on demand: Codex sends a client-side
  `tool_search` tool and adds the matching MCP tools to the conversation when the model searches.
  This needs this release's coding proxy; an older proxy refuses those models' requests with
  `openai_tool_not_allowed:tool_search`, MCP or not.

Time limits and the other rules in this guide apply to coding agents too. See
[Coding worker isolation](coding-worker-isolation.md#remote-mcp-tools) for the security notes.

## Time limits

Each call has `callTimeoutMs` (default `30000`, set on `attach_mcp_server`).
It must be at least `1000` and can't exceed `WARDBY_TOOL_MAX_TIMEOUT_MS`; a call runs with the lower of
the two, and never past the run's own deadline. `stop_run` aborts a call in
flight. A call that runs out of time returns `mcp_call_timeout` to the model
and the run goes on.

A coding agent's calls have one more limit: the coding proxy gives up on a forwarded call after 5
minutes, whatever `WARDBY_TOOL_MAX_TIMEOUT_MS` and `callTimeoutMs` say. The call then fails with
[`mcp_unavailable`](../help/errors/mcp-unavailable.md) (`502`), the gateway stops the call, and it
still counts against the run's call limit. A run that has been stopped or cancelled can't start new
calls: its token is refused with `401`.

## Refreshing and changes

`refresh_mcp_server` (and `update_mcp_server`) fetch the tool list again and
apply it at once. The reply lists tools added, removed and changed
(description or schema). A removed tool that an agent allows is dropped from
that agent's runs and shows under `missingTools` in `get_agent`; nothing
needs re-attaching if the server brings it back and you refresh again. A
tool the server newly adds is not available to any agent until you attach it.

## What a call does

Each call opens its own session: `initialize`, `notifications/initialized`,
`tools/call`, then a `DELETE` to end it. Because every call gets a fresh
session, a server that keeps state between calls in one session won't see
that state on the next call. Wardby checks on every call that the tool is
still attached and still in the saved list, and that the agent's owner still
owns the server or holds `use` on it; the call uses the server's current URL
and secrets. Arguments that aren't a JSON object return `invalid_arguments`
without calling the server. Text returned to the model is cut at 100,000
characters, with a note.

Wardby answers none of a server's own requests (sampling, elicitation,
roots). Notifications in a reply are ignored. A reply that carries only a
request from the server, and no answer to Wardby's request, fails the call
with `mcp_server_error`.

One log line per call records the run id, agent id, server id, tool,
outcome, duration and result size, never the arguments, the response or the
URL. Secret values are removed from results, errors and logs.

## Not supported

stdio servers, OAuth to a server (use a header secret), MCP resources,
prompts and sampling.

## Trust

A server's results are untrusted input to the model, like any tool result. The
allowlist is the control: attach only the tools an agent needs. A server's
annotations (read-only, destructive and so on) are hints from the server, not
something Wardby can verify. The one place Wardby acts on a hint is Codex coding
agents, which may use only tools marked `readOnlyHint: true` (see
[Coding agents](#coding-agents)).

## Sharing a server

Share a server you own with `grant_access` (`resourceType: "mcp_server"`, a
principal or `everyone`, level `read`, `use` or `write`; `everyone` is capped
at `use`). `read` lets the grantee see the server and its tool list; `use`
also lets them attach it to their own agents. The server's tools then run with
your brokered secrets, so grant `use` only to people you trust with them.
`write` allows nothing beyond `use`: only the owner updates, refreshes,
deletes or re-grants a server.

Sharing uses `grant_access` and `revoke_access`, which need the
`agents:write` scope; registering and attaching need `tools:write`.

An agent may use a server only while its owner owns the server or holds `use`
(or `write`) on it. `revoke_access`, and `grant_access` lowering a grant to
`read` (for a principal, or `everyone` from `use` to `read`), detach the
server at once from every agent whose owner can no longer use it; the reply
counts them under `attachmentsRemoved`. Your own agents, and agents whose
owner still holds `use` through another grant, keep it. Runs already going
lose the tools on their next call, which returns `mcp_tool_not_allowed`.

`delete_mcp_server` removes the server's tools from every agent attached to
it, including other owners' agents that use it through a grant, and removes
its grants.

When the server's secrets can't be loaded (a secret was deleted, or its
broker config no longer lists the server's host), the owner's own agents get
an `mcp_server_error` that names the secret. An agent using the server through
a grant gets only "The MCP server's credentials can't be used; ask its owner
to check it.", never the owner's secret names.

When a secret exists but the Wardby process making the call can't decrypt its
stored value, the call returns `mcp_server_credentials_unavailable`, and
`register_mcp_server`, `update_mcp_server` and `refresh_mcp_server` fail with
it as an HTTP 500 error. Every process that decrypts secrets (control plane,
scheduler, native gateway) must use the same `SECRET_APP_KEY`; if the key
changed, set the secret again. The owner's agents get that advice; an agent
using the server through a grant gets the generic message above. Each failure
also writes one operator `warn` log line with
`reason: "mcp_secret_decrypt_failed"`, the server and the secret name.

An attachment acts with the server owner's secrets. When `make_owner` gives an
agent a new owner, servers the new owner neither owns nor holds `use` on are
detached and listed under `bindingsRemoved` with `kind: "mcp_server"`.
`wardby grants adopt-public` and `wardby grants prune-bindings` remove them the
same way. An agent that holds an MCP server can't be made writable by
everyone.

## Troubleshooting

A failed call returns `{"error": "<code>", "message": "..."}` to the model;
the run goes on.

| Code                                                                                         | Meaning                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`mcp_servers_off`](../help/errors/mcp-servers-off.md)                                       | `WARDBY_MCP_SERVERS=off`.                                             |
| [`mcp_server_unreachable`](../help/errors/mcp-server-unreachable.md)                         | Wardby couldn't connect to the server.                                |
| [`mcp_server_auth_failed`](../help/errors/mcp-server-auth-failed.md)                         | The server answered 401 or 403.                                       |
| [`mcp_server_credentials_unavailable`](../help/errors/mcp-server-credentials-unavailable.md) | A secret can't be decrypted: check every process's `SECRET_APP_KEY`.  |
| [`mcp_server_error`](../help/errors/mcp-server-error.md)                                     | Another HTTP error, a malformed reply, or the tool reported an error. |
| [`mcp_tool_not_allowed`](../help/errors/mcp-tool-not-allowed.md)                             | Detached, off the allowlist, or the owner lost `use` on the server.   |
| [`mcp_tool_removed`](../help/errors/mcp-tool-removed.md)                                     | The server no longer lists the tool.                                  |
| [`mcp_call_timeout`](../help/errors/mcp-call-timeout.md)                                     | The call hit its time limit or the run was stopped.                   |
| [`mcp_call_limit`](../help/errors/mcp-call-limit.md)                                         | A coding run made more calls than `WARDBY_MCP_MAX_CALLS_PER_RUN`.     |
| [`mcp_unavailable`](../help/errors/mcp-unavailable.md)                                       | The coding proxy has no gateway to forward MCP calls to.              |

See also [Secrets and tools](tool-secrets.md) and
[Remote MCP servers](security-deployment.md#remote-mcp-servers).
