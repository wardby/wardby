# Run hooks

A run hook ties one of your sandbox tools to an agent's workflow events. When
the event happens, wardby itself calls the tool — the model is not involved —
with the event and the hook's settings. Use it to send results where your team
reads them: a Slack channel, an email, a ticket, a webhook. The destination
lives in the tool you write, so any service with an HTTP API works.

- One tool can be hooked to many agents.
- One agent can have many hooks, on the same events or different ones, and the
  same tool more than once (for example two Slack channels).
- Hooks are outbound only: nothing a tool returns goes back into a run.

## How it works

1. Something happens on the agent: a run finishes, a pull request opens, a
   review is posted. wardby records a workflow event — the same events
   [Slack notifications](slack-notifications.md) use, plus `run_completed`,
   which only hooks receive.
2. Every enabled hook on that agent whose filters take the event gets a
   delivery.
3. A delivery loop (one sender across replicas) calls the hook's tool in the
   sandbox with `{ event, config }`. If the tool throws or times out, the
   delivery is retried with backoff, up to 10 attempts; then it is marked
   failed and the hook's `lastError` says why.

Hooks deliver whether or not Slack is configured.

## Events

| Event              | When                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `run_completed`    | A run finished, in any end state: succeeded, failed, budget_exhausted, cancelled, lost, refused |
| `run_failed`       | A top-level run did not succeed                                                                 |
| `run_blocked`      | A top-level run was blocked by package refusals                                                 |
| `issue_picked_up`  | A Jira or GitHub issue was picked up                                                            |
| `pr_opened`        | A pull request was opened                                                                       |
| `review_posted`    | A review verdict was posted                                                                     |
| `review_fix`       | A review fix round started, or stopped at the round cap                                         |
| `pr_closed`        | A pull request was merged or closed                                                             |
| `packages_audited` | What a run's coding runs installed under package audit mode                                     |

`run_completed` fires for coding and native agents alike. By default it fires
for top-level runs only; a hook with `runs: "all"` also gets the runs a lead
delegated to (each child separately, with `parentRunId` set).

## What the tool receives

The tool's params are `{ event, config }`:

```json
{
  "event": {
    "schemaVersion": 1,
    "kind": "run_completed",
    "eventId": "cmw…",
    "occurredAt": "2026-01-05T07:08:39.000Z",
    "agent": { "id": "cmv…", "name": "weekly-auditor" },
    "runId": "cmw…",
    "data": {
      "agentName": "weekly-auditor",
      "status": "succeeded",
      "trigger": "scheduled",
      "parentRunId": null,
      "startedAt": "2026-01-05T07:00:09.000Z",
      "finishedAt": "2026-01-05T07:08:38.000Z",
      "costUsd": "3.211481",
      "reason": null,
      "pullRequests": [
        { "repository": "your-org/your-repo", "number": 12, "url": "https://…", "outcome": "pull_request_opened" }
      ]
    },
    "finalText": "# Weekly audit …",
    "finalTextTruncated": false
  },
  "config": { "channel": "C0123456789" }
}
```

- `data` holds the event kind's own fields. For `run_completed` they are shown
  above; `reason` is the first line of the run's error. The other kinds carry
  the same fields their Slack messages are built from (`prLabel`, `prUrl`,
  `verdict`, `round`, `merged`, …).
- `finalText` and `finalTextTruncated` appear only on a hook created with
  `includeFinalText` (see below), and only for events about a run.
- `event.test` is `true` on the synthetic event `test_run_hook` sends.

Write the tool's `paramsZod` to accept this shape. A loose schema is enough:

```js
z.object({ event: z.object({ kind: z.string() }).passthrough(), config: z.object({ channel: z.string() }) });
```

## Run output and secrets

By default a hook gets metadata only: no run output. `includeFinalText: true`
adds the run's final text — for an auditor, the report itself. Because that
sends the run's own output out of wardby, turning it on needs `agents:admin`
with the admin role, and the approving admin is recorded on the hook.

Before the tool sees it, the final text is masked by exact value against every
secret attached to the agent, then cut to 65,536 characters (a cut text ends
with a note saying so). Error text from a delivery is masked the same way
before it is stored or shown.

> Exact-value masking only knows secrets wardby holds. If a run quotes a
> credential it found somewhere else — an audit that reports a key committed to
> a repository, for instance — that text is not masked. Turn on
> `includeFinalText` only for agents whose output you are comfortable sending
> to the hook's destination.

The tool reads its own credentials with `secrets.get(name)` (or sends them with
`fetch(url, { secrets: [name] })` for a brokered secret). List them in the
hook's `allowedSecrets` and the hosts it calls in `allowedHosts`. As with
`attach_tool`, only the agent's owner can grant these, and they stop applying
if the agent changes owner until the new owner grants them again
(`list_run_hooks` shows `capabilitiesGranted`). A hook's `config` must not hold
a secret value; `create_run_hook` refuses one.

## Set up a hook

1. Create the tool with `create_tool` (and try it with `dry_run_tool`).
2. Attach the secret it needs to the agent (`attach_secret`).
3. Create the hook:

   ```json
   {
     "agentId": "<agent id>",
     "toolId": "<tool id>",
     "events": ["run_completed"],
     "statuses": [],
     "config": { "channel": "C0123456789" },
     "allowedSecrets": ["SLACK_BOT_TOKEN"],
     "allowedHosts": ["slack.com"],
     "includeFinalText": true
   }
   ```

   `create_run_hook` checks `config` against the tool's `paramsZod` with a
   sample event of every kind the hook takes, and refuses it if the schema
   rejects it.

4. Call `test_run_hook` with the hook's id. It sends a synthetic
   `run_completed` event (placeholder final text, never a real run's output)
   and returns `{ ok: true }` or the masked error.

Manage hooks with `update_run_hook` (send the full desired state; it also
clears `lastError`), `delete_run_hook`, and `list_run_hooks` (settings,
`lastError`, and pending/failed delivery counts). `delete_tool` refuses while a
hook uses the tool; `detach: true` also removes your own agents' hooks.

## Example: post to Slack

A tool that posts a short line, and the first part of the report when the hook
includes it. It reads a bot token secret and calls `chat.postMessage`.

```js
// paramsZod
z.object({ event: z.object({ kind: z.string() }).passthrough(), config: z.object({ channel: z.string() }) });
```

```js
// code
const { event, config } = params;
const d = event.data || {};
const head =
  event.kind === "run_completed"
    ? `${event.agent.name} finished: ${d.status} ($${d.costUsd})`
    : `${event.agent.name}: ${event.kind}`;
const body = event.finalText ? `${head}\n\n${event.finalText.slice(0, 2900)}` : head;
const token = await secrets.get("SLACK_BOT_TOKEN");
const r = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ channel: config.channel, text: body }),
});
const reply = JSON.parse(await r.text());
// Slack answers 200 with ok:false on errors: throw so wardby retries and records it.
if (!reply.ok) throw new Error(`slack: ${reply.error}`);
return "posted";
```

Hook it with `allowedSecrets: ["SLACK_BOT_TOKEN"]`, `allowedHosts: ["slack.com"]`
and `config: { "channel": "C…" }`. The bot must be in the channel.

## Post through the server's Slack connection

From 0.9.12, a hook can post to Slack without a token of its own: through the
bot wardby's [Slack notifications](slack-notifications.md) already use. The
token stays on the server; the tool never sees it. This needs a **system
tool** — a public tool an admin granted the Slack connection:

1. Write the tool (as in the example above, but with `slack.post` instead of
   `fetch`), then have an admin make it public with `make_tool_public`. From
   then on it has no owner: everyone can attach or hook it, and only an admin
   (`update_tool`, `delete_tool`) or the operator's CLI can change it.
2. An admin grants it the connection and limits where it may post:

   ```json
   { "toolId": "<tool id>", "connection": "slack", "channels": ["C0123456789"] }
   ```

   `channels` is a list of channel ids, or `["linked"]` (any channel that has
   a Slack notification link — an admin already approved posting there), or
   `["*"]` (any channel the bot is in). Granting again replaces the list;
   `revoke_tool_connection` removes it.

3. Teams hook it to their agents as usual, picking the channel in `config`. No
   `allowedSecrets` or `allowedHosts` are needed for the post.

```js
// code: a system tool that posts a summary and the report in its thread
const { event, config } = params;
const d = event.data || {};
const head = `*${event.agent.name}* finished: ${d.status} ($${d.costUsd})`;
const { ts } = await slack.post(config.channel, head);
if (event.finalText) {
  for (let i = 0; i < event.finalText.length && i < 5 * 3500; i += 3500) {
    await slack.post(config.channel, event.finalText.slice(i, i + 3500), { threadTs: ts });
  }
}
return "posted";
```

`slack.post(channel, text, { threadTs })` returns `{ ts }`. wardby checks the
channel against the grant on every call, masks the text by exact value against
the agent's secrets, and posts. A tool may post at most 20 messages per
delivery, each up to 40,000 characters. Failures come back as errors the tool
can throw on (and the hook retries): `slack_channel_not_granted`,
`slack_error: <code>` (Slack's own error code, such as `not_in_channel`), or
`connection_unavailable` — the tool isn't public, has no grant, or isn't
running from a run hook. Agents can't call `slack.post` from their own tool
calls; only hook deliveries and `test_run_hook` get the connection.

Changing a system tool is safe for the teams using it: when an admin updates a
public tool, every attachment and hook on an agent with an owner loses that
owner's capability grants (secrets, hosts) until the owner grants them again.
The Slack grant belongs to the tool, so a hook that only uses `slack.post`
keeps working. `wardby tool make-public`, `grant-connection` and
`revoke-connection` do the same from the CLI.

## Example: send an email

The same pattern with an email provider's HTTP API (replace the host, path and
body with your provider's):

```js
const { event, config } = params;
const d = event.data || {};
const subject = `[wardby] ${event.agent.name}: ${d.status ?? event.kind}`;
const text = event.finalText ?? `Run ${event.runId} ended ${d.status}.`;
const r = await fetch("https://api.your-email-provider.example/v1/send", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ to: config.to, subject, text }),
  secrets: ["EMAIL_API_KEY"],
});
if (r.status >= 300) throw new Error(`email: HTTP ${r.status}`);
return "sent";
```

Here `EMAIL_API_KEY` is a brokered secret whose broker places it on the
request for that host (see [Tool secrets](tool-secrets.md)).

## Troubleshooting

- `list_run_hooks` shows each hook's `lastError` and failed count.
- `hook_params_rejected` — the event and config no longer pass the tool's
  schema (the tool changed). Fix the schema or the config, then
  `update_run_hook`.
- `capabilitiesGranted: false` — the agent changed owner; the new owner
  re-grants with `update_run_hook`.
- Errors from the tool itself (`thrown: …`, `timeout: …`) are retried; the
  last one is kept.

See also the help articles `run-hooks` and `errors/run-hook-delivery-failed`.
