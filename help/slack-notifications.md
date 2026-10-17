---
id: slack-notifications
title: Send workflow updates to Slack
summary: Link a Slack channel to a Jira project or an agent to follow cards from pickup to merge, one thread per card.
audience: operator
tags: [slack, notifications, channels, jira, pull-requests, link_notification_channel]
appliesTo: >=0.6.0
---

# Send workflow updates to Slack

Link a Slack channel to a Jira project or to an agent (native or coding) and wardby posts
that project's or agent's workflow updates there — a card picked up, a pull
request opened, a review verdict, fix rounds, and the merge — with one thread
per card. This is outbound only: nothing in Slack starts or affects a run.

## Setup checklist

1. Create the Slack app from [`deploy/slack/app-manifest.yaml`](../deploy/slack/app-manifest.yaml)
   and install it to your workspace.
2. Copy the Bot User OAuth Token (`xoxb-…`).
3. Set `WARDBY_SLACK_BOT_TOKEN` (store it like any other provider credential)
   and restart wardby.
4. Link a channel with `link_notification_channel` — to a Jira project
   (`projectKey`) or to an agent (`agentId`).
5. Call `test_notification_channel` and confirm "✅ wardby is connected to
   this channel." posts there.

## Events

`issue_picked_up`, `run_failed` and `run_blocked` (top-level runs only), `pr_opened` (also for a
pull request opened from a GitHub issue mention), `review_posted` (approve / changes requested / comment), `review_fix` (round
started, or stopped at the cap), `pr_closed` (merged or closed, with any
Jira status move), and `packages_audited` (from Wardby 0.6.1, top-level runs
only: what its coding runs installed under package audit mode, described in
the `package-audit-mode` help article; it doesn't change the thread's status). `events` on a link narrows which of these post;
omitted means all eight. `includeCost` appends the run's spend line.

A `run_blocked` event uses the same ⛔ package registry wording and fixes as
[Run status comments](status-comments.md). See [Package refusal errors](errors/package-refusals.md)
for allowlist, release-age, advisory, and malware guidance.

wardby never posts code, diffs, review text, or run output to Slack.

## If something isn't posting

- The link's `lastError` (from `list_notification_channels`) names the
  problem. A channel error means the bot can't write there — see
  [`errors/slack-channel-unreachable`](errors/slack-channel-unreachable.md).
- No deliveries at all, for every channel, usually means the bot token is
  invalid, revoked, or missing a scope — see
  [`errors/slack-auth-failed`](errors/slack-auth-failed.md).
- A channel that recovers gets new events again right away; deliveries that
  already failed are not resent.
- Linking or testing refused outright means Slack isn't configured yet — see
  [`errors/slack-not-configured`](errors/slack-not-configured.md).

## Related

- [Run Jira agents](jira.md) — link a channel to the same project a Jira
  agent is linked to, to see its cards move end to end.
- [Automatic review fix rounds](review-fix-rounds.md) — the `review_fix`
  event covers these rounds.
- [Connect GitHub repositories](github.md) — pull-request events come from
  the same App your coding and review agents already use.

For the full guide, including scopes, threads, and failure modes, see
[`docs/slack-notifications.md`](../docs/slack-notifications.md).
