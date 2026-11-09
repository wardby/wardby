---
id: run-steps
title: See what a run is doing (run steps)
summary: Wardby records each run's steps, one line per tool call or model message, so you can follow a running run and read what a finished one did with get_run_steps.
audience: operator
tags: [run steps, viewer, wardby-runs, pane, step event, get_run_steps, what is my run doing, WARDBY_RUN_STEPS]
appliesTo: >=0.9.0
---

# See what a run is doing

Wardby records the steps of a run while it runs:

- one line for each **tool call**: the tool, and its command, file or first
  argument, cut to about 100 characters, with its status once the result is
  back (`ok`, `error`, or `exit N` for a command that exited with code N);
- one line for what the **model said**, cut to about 120 characters.

Tool output is never recorded, and neither is the full text of a command or
message.

Steps are recorded for native runs (in the control plane and on the native
sandbox) and for Claude Code and Codex runs. Every agent's shell command shows
as `Bash`: a native agent's `run_command`, Claude Code's command tool, and
Codex's `exec_command`, `shell`, `local_shell` and `shell_command`. Another tool
shows under its own name (for example `apply_patch`), and a remote MCP tool as
`mcp:<tool>`.

A Claude Code or Codex run's final answer is one `said` step: the start of the
summary it returned (the pull request description), or `Finished` with the
outcome (for example `Finished: changes ready`) when it returned none.

For Claude Code and Codex runs, the coding proxy reads the steps from the
model's replies after relaying them and posts them to the server, which needs a
listener for them: `WARDBY_RUN_STEPS_LISTEN` on `wardby serve` and
`WARDBY_RUN_STEPS_URL` on the proxy. The reference GKE manifests set both; the
kind overlay sets only `WARDBY_RUN_STEPS_URL`, so set
`WARDBY_RUN_STEPS_LISTEN` on the host's `wardby serve`. Without either, coding
runs record no steps; native runs are not affected. A slow or unreachable listener loses steps; it never slows the run.

## Read the steps

- `get_run_steps` with `runId` lists a run's steps, oldest first, 50 at a time
  (`limit`, at most 200). `next` is what to pass as `after` for the next page.
  To follow a running run, call it again every few seconds with `after` set to
  the last `seq` you have.
- `get_run` and `list_runs` (without `agentId`) include `lastStep`, the run's
  newest step as one line, for example `Bash: npm test (exit 1)`.
- The `wardby-runs` Claude Code pane shows a running run's last steps and a
  finished run's steps; see `claude-code-run-pane`.
- The admin viewer API sends a `step` event on `/admin/api/events` for each
  step and status, and `GET /admin/api/runs/<id>` lists the run's newest 200
  steps (see `admin-viewer`). The Wardby Viewer app shows them in a **Steps**
  section of a run's detail.

You can read a run's steps when you can read the run with `get_run`.

A run records at most 2,000 steps. Later steps are not recorded; `dropped`
counts them.

## Secrets

Before a step is stored, Wardby removes every secret value the run's agent has
(its attached secrets, readable or brokered, and its MCP servers' secrets) and
anything shaped like a token or key. A command that echoes a secret shows
`[REDACTED]` in its place.

## Retention

Steps are deleted `RUN_STEP_RETENTION_DAYS` after they are recorded (default
30). A change applies to steps recorded after it. `get_run_steps` reports `expired` when a run finished more than
`RUN_STEP_RETENTION_DAYS` ago and has no steps left.

## Settings

| Variable                  | Default   | What it does                                                                                                                                           |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WARDBY_RUN_STEPS`        | `summary` | `off` records no steps; `summary` records the lines above. `detail` is accepted and records `summary` in this release. Any other value stops start-up. |
| `RUN_STEP_RETENTION_DAYS` | `30`      | Days to keep a step, a whole number from 1 to 3650. Any other value stops start-up.                                                                    |
| `WARDBY_RUN_STEPS_LISTEN` | unset     | On `wardby serve` only: `host:port` (or `:port`) of the listener the coding proxy posts coding runs' steps to. Unset: no listener.                     |
| `WARDBY_RUN_STEPS_URL`    | unset     | On the coding proxy: the listener's origin, for example `http://<server host>:8792`, with no credentials or path. Unset: coding runs record no steps.  |

Set `WARDBY_RUN_STEPS` and `RUN_STEP_RETENTION_DAYS` on every process that runs
native agents or serves the native sandbox gateway: `wardby serve`,
`wardby scheduler`, `wardby run`, `wardby mcp` and `wardby native-gateway`. The
coding proxy reads `WARDBY_RUN_STEPS` too: with `off`, or with
`WARDBY_RUN_STEPS_URL` unset, no step text leaves the proxy. For a coding
run's steps use `wardby serve` (the only process that runs the listener), not
the stdio `wardby mcp`.

The listener is a second network path into the server, from the coding proxy
only; keep it off any load balancer. See
[Run steps](../docs/security-deployment.md#run-steps) for how to restrict it.

The full guide is
[Debugging agent runs](../docs/debugging-agent-runs.md#run-steps).
