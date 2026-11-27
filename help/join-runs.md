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
appliesTo: ">=0.11.0"
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

## From a terminal

From 0.11.1 you can also join from a terminal chat instead of through your
MCP client's agent:

1. Ask your agent to call `join_run` for the run. Its answer has
   `terminal.command`: `npx @wardby/cli@latest join '<link>'`, ready to copy
   (0.11.2 or later).
2. Run it. To keep the link out of your shell history and the process list,
   run `terminal.pasteCommand` (`npx @wardby/cli@latest join -`) instead and
   paste `terminal.link` when it asks. A link given as an argument starts
   working at once; its first token expires after 10 minutes, and the chat
   renews it in memory after that.
3. The chat shows the run's steps as they happen. Type a line and press Enter
   to send it; start it with `!` to interrupt. `/leave` leaves (the run
   finishes its work); `/quit` stops the agent after asking you to confirm:
   the run then ends cancelled and its work is not pushed. Ctrl-C leaves, as
   `/leave` does. After leaving, the chat keeps showing the run until it
   ends; press Ctrl-C (again) to stop watching.

Closing the terminal leaves the run too. If the connection to the server drops,
the chat retries for about a minute, then leaves the run on its way out so it
is not held open. Only a chat cut off for longer than 10 minutes cannot leave;
the run then stays open until its timeout, or until you join it again and
leave.

The link works until the run's timeout (plus a few minutes) and only for you.
It is a credential: do not share it. Every request it makes is checked against
your access again, so it stops working if you lose execute on the agent. An
admin with owner-all access can join any run from a terminal too, as long as
their admin role still grants it.

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
