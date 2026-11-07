---
id: run-steps
title: See what a run is doing (run steps)
summary: Wardby records each run's steps, one line per tool call or model message, so you can follow a running run and read what a finished one did with get_run_steps.
audience: operator
tags: [run steps, get_run_steps, lastStep, steps, progress, what is my run doing, stuck run, WARDBY_RUN_STEPS, RUN_STEP_RETENTION_DAYS]
appliesTo: >=0.9.0
---

# See what a run is doing

Wardby records the steps of a run while it runs:

- one line for each **tool call**: the tool, and its command, file or first
  argument, cut to about 100 characters, with its status once the result is
  back (`ok`, `error`, or `exit N` for a command that exited with code N);
- one line for what the **model said**, cut to about 120 characters.

Tool output is never recorded, and neither is the full text of a command or
message. A tool named `run_command` shows as `Bash`.

Steps are recorded for native runs, in the control plane and on the native
sandbox. Claude Code and Codex runs don't record steps.

## Read the steps

- `get_run_steps` with `runId` lists a run's steps, oldest first, 50 at a time
  (`limit`, at most 200). `next` is what to pass as `after` for the next page.
  To follow a running run, call it again every few seconds with `after` set to
  the last `seq` you have.
- `get_run` and `list_runs` (without `agentId`) include `lastStep`, the run's
  newest step as one line, for example `Bash: npm test (exit 1)`.

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

Set both on every process that runs native agents or serves the native sandbox
gateway: `wardby serve`, `wardby scheduler`, `wardby run`, `wardby mcp` and
`wardby native-gateway`.

The full guide is
[Debugging agent runs](../docs/debugging-agent-runs.md#run-steps).
