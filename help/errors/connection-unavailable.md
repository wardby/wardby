---
id: errors/connection-unavailable
title: slack.post failed with connection_unavailable
summary: The tool called slack.post without the server's Slack connection — it isn't public, has no grant, or isn't running from a run hook.
audience: operator
tags: [connection_unavailable, slack.post, system tool, grant_tool_connection, run hook]
appliesTo: ">=0.9.12"
---

# connection_unavailable

## What happened

A tool called `slack.post`, and the call had no Slack connection. Only a
public tool that an admin granted the Slack connection gets one, and only when
it runs from a run hook (a delivery or `test_run_hook`).

## What to do

1. An agent's own tool call, or `dry_run_tool`: `slack.post` isn't available
   there. Use it from a run hook.
2. Check the tool with `list_tools`: it must show `public: true` and
   `connections` with `slack`. If not, ask an admin to run
   `make_tool_public` and `grant_tool_connection`.
3. A grant revoked with `revoke_tool_connection` takes effect at the next
   delivery.

See [System tools](../system-tools.md).
