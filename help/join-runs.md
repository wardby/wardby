---
id: join-runs
title: Join a running coding run and talk to its agent
summary: With execute access to an agent you can join one of its running Claude Code coding runs, send the agent messages or interrupt it while it works, and keep the run open until you leave.
audience: operator
tags:
  [
    join,
    join_run,
    send_to_run,
    leave_run,
    join a run,
    talk to a running agent,
    steer an agent,
    interrupt a run,
    message a running agent,
  ]
appliesTo: ">=0.10.3"
---

# Join a running coding run

You can join a running coding run and talk to its agent while it works: point it at something it
missed, change the plan, or ask a question.

Joining works on **Claude Code** coding runs that are not workflow runs. Codex, the Gemini CLI and
native agents are not supported yet.

## Who can join

Anyone with **execute** access to the run's agent: its owner, anyone it is shared with at
`execute` or `write`, and the person who started the run. Execute access also lets you see all of
the agent's runs and their full step text, whoever started them.

## How it works

1. **Join**: call `join_run` with the run's id (from `list_runs` or `trigger_agent`).
2. **Send a message**: call `send_to_run` with your `message`. The agent picks it up at its next
   step, without restarting the run. Add `interrupt: true` to stop what it is doing first.
3. **Follow along**: call `get_run_steps` with `after` set to the last `seq` you have. Your message
   shows as a step of kind `message` (or `interrupt`) with `from` set to you, followed by the
   agent's reply and tool calls.
4. **Leave**: call `leave_run`. When the last person leaves and the agent has finished, the run wraps
   up as usual and opens or updates its pull request.

While anyone is joined the run stays open after the agent finishes its task, so you can keep
talking to it. The run's **timeout** still applies: a joined run ends when the last person leaves
**or** the timeout is reached, whichever comes first. Raise the agent's `codingProfile.timeoutSec` if you
need longer sessions. The run's budget caps all of it; joining never raises the budget.

The turn limit (`codingProfile.maxTurns`) applies to each message separately: the agent's turns answering
you do not use up the task's turns.

## What others see

Join, leave and message steps appear in the run's steps for everyone who can see the run. Secret
values in a message are masked before it is stored or sent to the agent.

## Requirements

Run steps must be on: `WARDBY_RUN_STEPS` not `off` (the default is `summary`) and the agent's `runSteps` not
`off`, with the control plane's run-steps listener (`WARDBY_RUN_STEPS_LISTEN`) and the coding
proxy's `WARDBY_RUN_STEPS_URL` configured. See [Run steps](run-steps.md).

## Errors

- [`run_not_running`](errors/run-not-running.md): the run already finished or has not started.
- [`join_not_supported`](errors/join-not-supported.md): not a Claude Code run, or a workflow run.
- [`join_unavailable`](errors/join-unavailable.md): the run keeps no run steps.
- [`run_not_joined`](errors/run-not-joined.md): join before you send.
