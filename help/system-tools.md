---
id: system-tools
title: System tools — public tools that post with the server's Slack bot
summary: An admin makes a tool public (make_tool_public) and grants it the server's Slack connection (grant_tool_connection); run hooks on it post with slack.post, no token needed.
audience: operator
tags: [system tool, public tool, make_tool_public, grant_tool_connection, slack.post]
appliesTo: ">=0.9.12"
---

# System tools

A system tool is a public tool (no owner) that an admin may grant one of the
server's own connections. Slack is the only one: a run hook on the tool can
post with `slack.post`, through the bot wardby's notifications already use. The
bot token never reaches the tool, and teams don't copy a token into secrets.

## Set one up (admin)

1. Create the tool with `create_tool`, using `slack.post` (below).
2. `make_tool_public { toolId }` — it loses its owner. Everyone can attach or
   hook it; only an admin (`update_tool`, `delete_tool`) or the operator's CLI
   can change it. Refused while it runs for another owner's agent, or when a
   public tool already has its name.
3. `grant_tool_connection { toolId, connection: "slack", channels }`, where
   `channels` is a list of channel ids, `["linked"]` (any channel with a Slack
   notification link), or `["*"]` (any channel the bot is in). Granting again
   replaces it; `revoke_tool_connection` removes it.

`list_tools` and `get_agent` show a public tool's `connections` to everyone.

## Use one (any team)

`create_run_hook` with the tool, your agent, and `config.channel`. No
`allowedSecrets` or `allowedHosts` are needed for the post. Then
`test_run_hook`.

## slack.post

```js
const { ts } = await slack.post(config.channel, "Run finished");
await slack.post(config.channel, "details…", { threadTs: ts });
```

- The channel must be inside the grant (`slack_channel_not_granted`).
- Text is masked by exact value against the agent's secrets before posting.
- At most 20 posts per delivery, each 1–40,000 characters.
- Slack refusals come back as `slack_error: <code>`, for example
  `channel_unreachable:not_in_channel` (invite the bot to the channel).
- Only run hook deliveries and `test_run_hook` get the connection; anywhere
  else `slack.post` throws `connection_unavailable`.

## Changing a system tool

An admin's `update_tool` on a public tool goes through even while teams use
it. Every attachment and hook on an agent with an owner loses that owner's
capability grants (secrets, hosts) until they grant them again
(`attach_tool`, `update_run_hook`); the result's `consentCleared` counts them.
Hooks that only use `slack.post` keep working.

CLI equivalents: `wardby tool make-public`, `wardby tool grant-connection
<tool> slack --channels <C1,C2|linked|*>`, `wardby tool revoke-connection`.

See also [Run hooks](run-hooks.md), [connection_unavailable](errors/connection-unavailable.md)
and [slack_channel_not_granted](errors/slack-channel-not-granted.md).
