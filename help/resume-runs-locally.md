---
id: resume-runs-locally
title: Resume Claude Code runs locally (sessionResume, get_run_transcript, wardby resume)
summary: Keep each Claude Code run's redacted conversation with sessionResume, then continue it on your machine with get_run_transcript and npx wardby resume.
audience: operator
tags: [sessionResume, wardby resume, get_run_transcript, transcript, blob-store, WARDBY_SESSION_TRANSCRIPTS]
appliesTo: ">=0.7.0"
---

# Resume Claude Code runs locally

`sessionResume` makes a Claude Code agent keep a redacted copy of each run's
conversation, so the session can be continued locally in Claude Code with
`get_run_transcript` and `npx wardby resume`. It is off by default and is not
available for Codex agents. It needs Claude Code worker images from Wardby
0.7.0 or later.

## Turn it on

```json
{ "id": "<coding agent id>", "codingProfile": { "sessionResume": true } }
```

Use `update_agent` or `create_agent`. The server needs a blob store
(`BLOB_STORE`, with `BLOB_STORE_LOCAL_DIR`, `BLOB_STORE_GCS_BUCKET`, or
`BLOB_STORE_S3_BUCKET` and `BLOB_STORE_S3_REGION`, plus the optional
`BLOB_STORE_S3_ENDPOINT` for an S3-compatible store) set on the **server
process** that launches coding runs, not only on the coding proxy. Without a
blob store nothing is stored, and `update_agent` warns you.

## What is stored

- The conversation as Claude Code recorded it: user and assistant messages,
  tool calls and their results, compaction summaries, files and skills the
  agent loaded, and a session title (`wardby run <id>: <task>` when Claude
  Code made none).
- Removed: thinking blocks, the system prompt, the worker's environment, date
  and budget reminders, account and organisation details, and billing
  records.
- Redacted: the values of the agent's attached secrets, plus the run's
  capability and registry token by their token shape. If the agent's secrets
  cannot be loaded, nothing is stored.
- Stored for runs that finish, stop at their budget, or fail. Not stored for
  runs stopped with `stop_run` or ended by their timeout.
- Stored gzip-compressed under the `run-transcripts/` prefix. When the run's
  context was compacted, only what a resume loads is kept: the last
  compaction's summary, the messages it kept, and everything after it.
- At most `RUN_TRANSCRIPT_MAX_BYTES` per run, measured before compression
  (default 10 MiB, at most 64 MiB). Each run records a status (`stored`,
  `too_large`, `not_captured` or `failed`) with a reason code.

## Who can read it

Transcripts are stored from the first run with `sessionResume` on. Anyone
who can read a run (its triggerer and the agent's owner, as for `get_run`)
can download its transcript, which includes
what the agent saw in the repository and in command output. Redaction removes secret
values, not other sensitive text. Turn this on only for agents whose runs you
are comfortable sharing with everyone who can read them.

## Continue a run on your machine

1. Ask your MCP client to call `get_run_transcript` with the run id (same
   access as `get_run`). For a stored transcript it returns a download link
   that works for 10 minutes and the command to run; otherwise the status
   (`none`, `too_large`, `not_captured`, `failed`, `expired`, `unavailable`,
   `unsupported`) and what it means.
2. Run the command in a terminal, `npx wardby resume -`, and paste the link
   when it asks. (A link given as an argument stays in shell history and the
   process list.) For a GitHub repository, run it inside a clone of that
   repository. A `local:` repository is used only when the link comes from
   this machine (a stdio MCP server); otherwise pass `--here` or `--dir`.

It verifies the download's SHA-256, writes the session to
`~/.wardby/sessions/<run id>/<session id>.jsonl` (mode 0600, never into
Claude Code's own config directory), adds a detached git worktree of the
run's branch next to the repository (the base commit, with a warning, when
the branch is gone), and starts `claude --resume` there. A stand-in
`wardby_tools` server shows the run's `run_command` calls but runs nothing,
and a note tells the model `/workspace` is now the worktree.

Options: `--dir <path>` (worktree location), `--here` (no checkout),
`--force` (replace a different imported session file), `--print` (print the
`claude` command instead of starting it). The command passes
`--system-prompt-snapshot off` so the move note applies; remove it for a
Claude Code older than 2.1.257 when the version could not be read. Under
`npx`, the MCP config points into the npx cache: run `wardby resume` again if
the cache was cleaned.

The link is a credential until it expires: do not share it. Over stdio it
points at a local port the MCP server opens, so keep your MCP client
connected until the download finishes. The token is in the link's query
string: keep `/run-transcripts/download` out of load-balancer and ingress
access logs. Refusals:
[Run transcript download refused](errors/run-transcript-download.md).

## Retention

`RUN_TRANSCRIPT_RETENTION_DAYS` is a whole number from 1 to 3650 (default 30).
Expired transcripts are pruned when new ones are stored. On GCS or S3 also add
a bucket lifecycle rule on the `run-transcripts/` prefix.

## Set it up per deployment

Give transcripts a bucket of their own, not the dependency cache bucket, that
only the control plane can use.

- GKE: `session_transcripts_enabled` and `session_transcripts_bucket_name` in
  Terraform (optionally `session_transcripts_retention_days`), then
  `WARDBY_SESSION_TRANSCRIPTS=true deploy/gke/up.sh`. Terraform adds the
  lifecycle rule; `up.sh` passes the same retention to the control plane.
- AWS: the same Terraform variables, then give the control plane `BLOB_STORE=s3`,
  the `session_transcripts_bucket` output as `BLOB_STORE_S3_BUCKET`,
  `BLOB_STORE_S3_REGION`, and the `session_transcripts_retention_days` output as
  `RUN_TRANSCRIPT_RETENTION_DAYS`.
- kind harness and Docker quickstart: the server runs on your host. Set
  `BLOB_STORE=local` and `BLOB_STORE_LOCAL_DIR` in its environment (for the
  quickstart, in `.wardby/.env`).

## Startup and custom images

With `JOB_LAUNCHER` set to `docker` or `kubernetes`, a half-set `BLOB_STORE`
or an invalid `RUN_TRANSCRIPT_RETENTION_DAYS` or `RUN_TRANSCRIPT_MAX_BYTES` stops
the server at startup,
naming the variable. An agent with its own `workerImageRef` image must rebuild
it from a release that includes session resume (see
[Build a tool runner image for a Claude Code agent](help://build-claude-code-image)),
or its runs fail at input with `worker_input_failed`.

Full setup: [Resume a run locally](../docs/coding-agent-setup.md#resume-a-run-locally).
See also [Choose a native or coding agent](help://creating-agents).
