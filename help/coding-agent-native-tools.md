---
id: coding-agent-native-tools
title: Native tools on Claude Code coding agents
summary: Attach a native Wardby tool to a Claude Code coding agent with attach_tool; its runs call it as mcp__wardby_mcp__<tool name>, with the attachment's secrets, datastores and hosts, through the native gateway. Codex agents can't take native tools yet.
audience: operator
tags:
  [
    attach_tool,
    coding agent tools,
    coding agents,
    claude-code,
    native tools,
    sandbox tools,
    mcp,
    codex,
    datastore,
    brokered secrets,
    WARDBY_MCP_MAX_CALLS_PER_RUN,
    update_agent,
    coding_failure_native_tool_duplicate_names,
  ]
appliesTo: ">=0.10.2"
---

# Native tools on Claude Code coding agents

A Claude Code coding agent can call native Wardby tools, the same tools a native agent uses. That
lets one agent work in a repository checkout and also call a custom tool, such as a search API
behind a brokered secret or a datastore lookup.

## Attach a tool

Use `attach_tool` exactly as for a native agent, with the same capability fields:

```json
{
  "agentId": "<coding agent id>",
  "toolId": "<tool id>",
  "allowedSecrets": ["SEARCH_API_KEY"],
  "allowedHosts": ["search.example.com"],
  "allowedDatastorePrefixes": ["notes/"],
  "allowedSharedDatastorePrefixes": { "kb": ["public/"] }
}
```

- The agent's runs see the tool as `mcp__wardby_mcp__<tool name>`, with its description and schema.
- The name must use only letters, digits, `_` and `-` (up to 64 characters), the description must
  be at most 262,144 characters, and the name must not be the same as one of the agent's MCP tools
  (`<server name>__<tool name>`). `attach_tool`, `wardby tool attach` and a bundle import all
  refuse a tool that doesn't fit (the import skips it with a warning).
- Only the agent's owner can grant capabilities, as for native agents.
- Two attached tools with the same name fail the run before launch with
  [`coding_failure_native_tool_duplicate_names`](errors/coding-native-tool-duplicate-names.md).

## How a call runs

The worker never runs the tool. The call goes worker → coding proxy `/mcp` → native gateway, the
same path as the agent's [remote MCP tools](mcp-servers.md). The gateway:

- uses the tool version the run started with: its code, parameter schema, time limit and the
  attachment's grants are fixed when the run is launched, as in a native run, so `update_tool` or a
  grant change applies to the next run. The proxy and the worker see only the tool's name,
  description and schema;
- checks on every call that the tool is still attached: a detached tool is refused with
  [`mcp_tool_not_allowed`](errors/mcp-tool-not-allowed.md);
- runs the tool in the gateway process, in the same sandbox and under the same time limits as a
  native agent's control-plane run. A slow tool can hold up the gateway for up to its time limit,
  so keep the time limits of these tools short;
- runs it with the attachment's grants: secrets (brokered ones only through
  `fetch`), the agent's private `datastore.*` and its attached `sharedDatastore.*` stores under the
  granted prefixes, the allowed hosts, and the tool's `timeoutMs`, never past the run's deadline;
- removes every value of the attachment's secrets from the result and from any error before
  returning it. If the secrets can't be read, the tool does not run and the call returns
  `secret_check_unavailable`;
- counts the call against `WARDBY_MCP_MAX_CALLS_PER_RUN` together with MCP tool calls
  ([`mcp_call_limit`](errors/mcp-call-limit.md)). `stop_run` stops a call in flight.

## Codex agents

Codex coding agents can't take native tools yet. `attach_tool` refuses a Codex agent (and a coding
agent with no coding profile): "Native tools work only on Claude Code coding agents for now; Codex
support is tracked separately." If `update_agent` switches an agent with attached tools to Codex,
the change goes ahead, the tools stay attached but Codex runs don't get them, and the result's
`warnings` names them: "These native tools won't be available to Codex runs: …".

When `update_agent` makes an agent a Claude Code agent (from a native agent or from Codex), its
tools stay attached. Any whose name or description Claude Code can't be offered are left out of
its runs, and `warnings` names them: "These native tools won't be available to Claude Code runs
(…): …". Rename the tool (create a new one) or shorten its description with `update_tool`.

## Deployment

Nothing new to set: native tools use the MCP settings. The coding proxy needs
`WARDBY_MCP_GATEWAY_URL`; in low-power mode a run with native tools wakes the native gateway; the
Substrate launcher works too. Upgrade the coding proxy and the native gateway with the server: an
older proxy refuses the requests of a run that has native tools. No new worker image is needed.

Full guide: [Native tools on Claude Code agents](../docs/mcp-servers.md#native-tools-on-claude-code-agents).
See also [Use native agents, tools, and data](native-capabilities.md) and
[Brokered secrets](brokered-secrets.md).
