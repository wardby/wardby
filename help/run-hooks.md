---
id: run-hooks
title: Run hooks — send results to Slack, email or any API
summary: Tie a sandbox tool to an agent's events (run_completed and more) so wardby calls it with the event, and optionally the run's report.
audience: operator
tags: [hooks, run hook, run_completed, create_run_hook, test_run_hook, slack, email, notifications]
appliesTo: ">=0.9.8"
---

# Run hooks

A run hook ties one of your sandbox tools to an agent's workflow events. When
one happens, wardby (not the model) calls the tool with `{ event, config }`.
The tool decides where it goes: Slack, email, a ticket, a webhook.

## Set one up

1. Write the tool with `create_tool`; its `paramsZod` must accept
   `{ event, config }`, for example
   `z.object({ event: z.object({ kind: z.string() }).passthrough(), config: z.object({ channel: z.string() }) })`.
2. Attach the secret the tool needs to the agent (`attach_secret`).
3. `create_run_hook` with `agentId`, `toolId`, `events` (empty = all),
   `config`, `allowedSecrets` and `allowedHosts`.
4. `test_run_hook` sends a synthetic `run_completed` event and returns
   `{ ok: true }` or the error.

## Events and filters

- `run_completed` — any finished run, every end state. `statuses` narrows it
  (for example `["failed", "budget_exhausted"]`); `runs: "all"` adds child
  runs a lead delegated to (default `"top_level"`).
- The Slack events too: `run_failed`, `run_blocked`, `issue_picked_up`,
  `pr_opened`, `review_posted`, `review_fix`, `pr_closed`, `packages_audited`.

One agent can have many hooks, and one tool can serve many agents; each hook
is delivered on its own, retried with backoff up to 10 times.

## The run's report

Hooks get metadata only, unless the hook has `includeFinalText: true`, which
adds the run's final text — masked against the agent's secrets and cut to
65,536 characters. Turning it on needs `agents:admin` with the admin role.
Masking only knows wardby's own secrets: a credential a run found elsewhere
and quoted is not masked.

## Posting with the server's Slack bot

From 0.9.12 a hook can post to Slack without its own token, through a system
tool: a public tool an admin granted the server's Slack connection. The tool
calls `slack.post(channel, text, { threadTs })`; the token stays on the
server. Search help for "system tools".

## Check on hooks

`list_run_hooks` shows each hook's settings, `capabilitiesGranted`,
`lastError`, and pending/failed counts. `update_run_hook` (full desired state)
fixes one and clears `lastError`; `delete_run_hook` removes it.

## Related

- [Send workflow updates to Slack](slack-notifications.md) — the built-in
  Slack messages use the same events.
- [A run hook delivery failed](errors/run-hook-delivery-failed.md)
- [A run hook config was refused](errors/hook-config-rejected.md)

For the full guide, with Slack and email tool examples and the payload
reference, see [`docs/run-hooks.md`](../docs/run-hooks.md).
