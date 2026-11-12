---
id: errors/slack-channel-not-granted
title: slack.post refused the channel (slack_channel_not_granted)
summary: The hook asked a system tool to post to a channel outside the tool's Slack grant.
audience: operator
tags: [slack_channel_not_granted, slack.post, system tool, grant_tool_connection, channel]
appliesTo: ">=0.9.12"
---

# slack_channel_not_granted

## What happened

A system tool called `slack.post` with a channel its Slack grant doesn't
cover. The grant's `channels` is a list of channel ids, `["linked"]` (only
channels with a Slack notification link), or `["*"]` (any channel the bot is
in).

## What to do

1. Check the hook's `config` (`list_run_hooks`): is the channel id right?
2. See the grant in `list_tools` (`connections`).
3. Ask an admin to add the channel (`grant_tool_connection` again with the
   full list), or to link it for notifications when the grant is `linked`.

See [System tools](../system-tools.md).
