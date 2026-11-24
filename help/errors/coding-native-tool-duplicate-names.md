---
id: errors/coding-native-tool-duplicate-names
title: A Claude Code run failed before launch because two attached tools share a name
summary: The run failed with coding_failure_native_tool_duplicate_names because the agent has two attached native tools with the same name; detach all but one and trigger it again.
audience: operator
tags:
  [
    error,
    coding-agents,
    claude-code,
    native tools,
    attach_tool,
    coding_failure_native_tool_duplicate_names,
    coding_native_tool_duplicate_names,
  ]
appliesTo: ">=0.10.2"
---

# A Claude Code run failed before launch because two attached tools share a name

## What happened

The run's error starts with `coding_failure_native_tool_duplicate_names`, followed by a diagnostic
id. When Wardby launches a Claude Code run, it fixes the agent's attached native tools for that run.
Two of them have the same name (tool names are unique per owner, so this can be your tool and a
public or another owner's tool). The run would see one name for two tools, so Wardby failed it
rather than pick one. Nothing was launched, so the run made no changes. A native agent's run fails
the same way.

The run's error contains only the code and the diagnostic id. The control plane log has the tool
name at `warn`, under the same diagnostic id, with the internal code
`coding_native_tool_duplicate_names`.

## What to do

1. List the agent's tools with `get_agent` and find the two with the same name.
2. Detach all but one with `detach_tool`, then trigger the agent again.

Every attach path refuses a second tool with the same name, so this usually means the attachments
were made by an older version or edited in the database.

See [Native tools on Claude Code coding agents](../coding-agent-native-tools.md).
