---
id: run-steps
title: See what a run is doing (run steps)
summary: Wardby records each run's steps, one line per tool call or model message, so you can follow a running run and read what a finished one did with get_run_steps. Run steps detail adds tool output.
audience: operator
tags: [run steps, claude code run steps, get_run_steps, what is my run doing, WARDBY_RUN_STEPS, viewer step event]
appliesTo: >=0.9.0
---

# See what a run is doing

Wardby records the steps of a run while it runs:

- one line for each **tool call**: the tool, and its command, file or first
  argument, cut to about 100 characters, with its status once the result is
  back (`ok`, `error`, or `exit N` for a command that exited with code N);
- one line for what the **model said**, cut to about 120 characters.

## Levels

| Level     | Tool input           | Tool result                             | Model text           |
| --------- | -------------------- | --------------------------------------- | -------------------- |
| `off`     | -                    | -                                       | -                    |
| `summary` | about 100 characters | status only (`ok`, `error`, `exit N`)   | about 120 characters |
| `detail`  | up to about 4 KB     | status and the last ~2 KB of its output | up to about 8 KB     |

At `summary`, the default, tool output is never recorded. At `detail` each step
also keeps a **detail** text, at most 16 KB. When the output is cut at the
start, the partial first line is dropped if it ends within 256 characters;
otherwise only the first 256 characters are dropped, so a long single-line
output, such as a JSON result, keeps about its last 1.8 KB. At every level,
terminal escape sequences (colour codes, links, clipboard writes, title changes)
and every other control character except line breaks and tabs are removed from
step text before it is stored.

A run's level is the lower of two settings, fixed when the run is dispatched (a
change reaches later runs only; lowering the ceiling also stops detail for runs
already in flight):

- the instance's ceiling, `WARDBY_RUN_STEPS` (default `summary`);
- the agent's `runSteps` (`off`, `summary` or `detail`), set by the agent's
  owner with `create_agent` or `update_agent`. Unset counts as `summary`. Set
  `null` to clear it.

So `detail` needs both the operator and the agent's owner. If `runSteps` asks
for more than the instance allows, the value is stored, `update_agent` and
`get_agent` say so in `warnings`, and runs record at the ceiling.

> **Warning: `detail` stores tool output.** Before a step is stored, every
> secret value the run was given is removed and anything shaped like a token or
> key is masked. A secret that exists only inside a repository file, or another
> source the run read, and that matches no known shape, is not known to Wardby
> and can remain in the detail text. That is why detail is off unless both the
> operator and the agent's owner ask for it. Turn it on only for agents whose
> tool output you are prepared to keep for the retention period.

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

At `detail`, `get_run_steps` also returns each step's `detail` to the agent's
owner and to the person who started the run (and to the stdio operator); anyone
else, including an admin who does not own the agent, gets the lines only. `lastStep`, the admin viewer API
and its `step` events never include detail.

You can read a run's steps when you can read the run with `get_run`.

A run records at most 2,000 steps. Later steps are not recorded; `dropped`
counts them.

## Secrets

Before a step is stored, Wardby removes every secret value the run's agent has
(its attached secrets, readable or brokered, and its MCP servers' secrets), the
run's own capability and registry token, and
anything shaped like a token or key. A command that echoes a secret shows
`[REDACTED]` in its place.

## Retention

Steps, and their detail, are deleted `RUN_STEP_RETENTION_DAYS` after they are
recorded (default 30). A change applies to steps recorded after it. `get_run_steps` reports `expired` when a run finished more than
`RUN_STEP_RETENTION_DAYS` ago and has no steps left.

## Settings

| Variable                  | Default   | What it does                                                                                                                                                                        |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WARDBY_RUN_STEPS`        | `summary` | `off` records no steps; `summary` the lines above; `detail` allows agents whose `runSteps` is `detail` to record detail. The ceiling for every run. Any other value stops start-up. |
| `RUN_STEP_RETENTION_DAYS` | `30`      | Days to keep a step, a whole number from 1 to 3650. Any other value stops start-up.                                                                                                 |
| `WARDBY_RUN_STEPS_LISTEN` | unset     | On `wardby serve` only: `host:port` (or `:port`) of the listener the coding proxy posts coding runs' steps to. Unset: no listener.                                                  |
| `WARDBY_RUN_STEPS_URL`    | unset     | On the coding proxy: the listener's origin, for example `http://<server host>:8792`, with no credentials or path. Unset: coding runs record no steps.                               |

Set `WARDBY_RUN_STEPS` (including `detail`) and `RUN_STEP_RETENTION_DAYS` on
every process that writes steps: `wardby serve`,
`wardby scheduler`, `wardby run`, `wardby mcp` and `wardby native-gateway`. The
coding proxy reads `WARDBY_RUN_STEPS` too: with `off`, or with
`WARDBY_RUN_STEPS_URL` unset, no step text leaves the proxy. For a coding
run's steps use `wardby serve` (the only process that runs the listener), not
the stdio `wardby mcp`.

For coding runs at `detail`, set `WARDBY_RUN_STEPS=detail` on the coding proxy
too: below `detail`, the proxy never sends any tool output to the server.

The listener is a second network path into the server, from the coding proxy
only; keep it off any load balancer. See
[Run steps](../docs/security-deployment.md#run-steps) for how to restrict it.

The full guide is
[Debugging agent runs](../docs/debugging-agent-runs.md#run-steps).
