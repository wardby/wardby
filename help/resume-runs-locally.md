---
id: resume-runs-locally
title: Keep Claude Code run transcripts for local resume
summary: Turn on sessionResume for a Claude Code agent so each run's redacted conversation is stored on the server, and set up the blob store and retention it needs.
audience: operator
tags: [sessionResume, resume, transcript, claude-code, blob-store, RUN_TRANSCRIPT_RETENTION_DAYS, retention, redaction]
appliesTo: ">=0.7.0"
---

# Keep Claude Code run transcripts for local resume

`sessionResume` makes a Claude Code agent keep a redacted copy of each run's
conversation, so a developer can later continue that session in their own
Claude Code. It is off by default and is not available for Codex agents.

## Turn it on

```json
{ "id": "<coding agent id>", "codingProfile": { "sessionResume": true } }
```

Use `update_agent` or `create_agent`. The server needs a blob store
(`BLOB_STORE`, with `BLOB_STORE_LOCAL_DIR`, `BLOB_STORE_GCS_BUCKET`, or
`BLOB_STORE_S3_BUCKET` and `BLOB_STORE_S3_REGION`) set on the **server
process** that launches coding runs, not only on the coding proxy. Without a
blob store nothing is stored, and `update_agent` warns you.

## What is stored

- The conversation only: user and assistant messages and the session title.
- Removed: thinking blocks, the system prompt, the environment, and account
  and budget data.
- Redacted: the values of the agent's attached secrets, plus the run's
  capability and registry token by their token shape. If the agent's secrets
  cannot be loaded, nothing is stored.
- Stored for runs that finish, stop at their budget, or fail. Not stored for
  runs stopped with `stop_run` or ended by their timeout.
- At most 10 MiB per run, under the `run-transcripts/` prefix. Each run
  records a status (`stored`, `too_large`, `not_captured` or `failed`) with a
  reason code.

## Who can read it

Anyone who can read the run can read its transcript, which includes what the
agent saw in the repository and in command output. Redaction removes secret
values, not other sensitive text. Turn this on only for agents whose runs you
are comfortable sharing with everyone who can read them.

## Retention

`RUN_TRANSCRIPT_RETENTION_DAYS` is a whole number from 1 to 3650 (default 30).
Expired transcripts are pruned when new ones are stored. On GCS or S3 also add
a bucket lifecycle rule on the `run-transcripts/` prefix.

## Startup and custom images

With `JOB_LAUNCHER` set to `docker` or `kubernetes`, a half-set `BLOB_STORE`
or an invalid `RUN_TRANSCRIPT_RETENTION_DAYS` stops the server at startup,
naming the variable. An agent with its own `workerImageRef` image must rebuild
it from a release that includes session resume (see
[Build a tool runner image for a Claude Code agent](help://build-claude-code-image)),
or its runs fail at input with `worker_input_failed`.

Full setup: [Resume a run locally](../docs/coding-agent-setup.md#resume-a-run-locally).
See also [Choose a native or coding agent](help://creating-agents).
