---
id: join-runs
title: Join a running run and talk to its agent
summary: With execute access to an agent you can join one of its running native agent or Claude Code coding runs, send the agent messages or interrupt it while it works, and keep the run open until you leave.
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
    join native agent,
    native agents,
  ]
appliesTo: ">=0.11.0"
---

# Join a running run

You can join a running run and talk to its agent while it works: point it at something it
missed, change the plan, or ask a question.

Joining works on **native agent** runs (from 0.11.3, in the control plane and in a sandbox) and on
**Claude Code** coding runs, including workflow runs (from 0.11.4; see [Workflow runs](#workflow-runs)).
Codex and the Gemini CLI are not supported yet.

## Workflow runs

On a workflow run, your messages reach the run's lead session: the Claude Code session that started
the repository workflow script and waits for it. The workflow's sub-agents do not see them.

- **While the workflow runs**, each message reaches the lead with a short status line (the phase it
  is on and how many of its agents have finished), so it can tell you how the workflow is going.
- **Stop or restart**: ask the lead to stop the workflow, or to stop it and start it again. A
  restart always uses the run's own workflow arguments, and a run may launch its workflow at most
  five times. The run's result comes from the last launch.
- **Stop without restarting**: when the lead stops the workflow at your request and it is not
  started again, the run ends **cancelled**, as `/quit` does: nothing is pushed, and the run's
  error says it was stopped from a joined chat (and by whom). `/quit` stops the whole run at once.
- **After the workflow**, talk to the lead as on any coding run: ask what changed, or ask for one
  more fix. The run stays open until the last person leaves or its timeout.
- An interrupt (`/i`) stops the lead's current turn, not the workflow.

`/agent` shows the run's workflow.

## Who can join

Anyone with **execute** access to the run's agent: its owner, anyone it is shared with at
`execute` or `write`, and the person who started the run. Execute access also lets you see all of
the agent's runs and their full step text, whoever started them.

## How it works

1. **Join**: call `join_run` with the run's id (from `list_runs` or `trigger_agent`).
2. **Send a message**: call `send_to_run` with your `message`. The agent reads it once it finishes what
   it is doing now, without restarting the run. Add `interrupt: true` to have it stop and handle
   your message at once.
3. **Follow along**: call `get_run_steps` with `after` set to the last `seq` you have. Your message
   shows as a step of kind `message` (or `interrupt`) with `from` set to you, followed by the
   agent's reply and tool calls.
4. **Leave**: call `leave_run`. When the last person leaves and the agent has finished, the run wraps
   up as usual: a coding run opens or updates its pull request, a native run records its final
   answer.

While anyone is joined the run stays open after the agent finishes its task, so you can keep
talking to it. The run's **timeout** still applies: a joined run ends when the last person leaves
**or** the timeout is reached, whichever comes first. Raise the agent's time limit if you need
longer sessions: `codingProfile.timeoutSec` on a coding agent, `timeoutSec` on a native agent
(default 1800 seconds, at most 3600). A native run stops waiting for messages a minute before its
timeout, so it still finishes normally. The run's budget caps all of it; joining never raises the
budget.

The turn limit (`codingProfile.maxTurns` on a coding agent, `maxTurns` on a native agent) applies to
each message separately: the agent's turns answering you do not use up the task's turns.

On a Claude Code run, a message reaches the agent as soon as it finishes its current answer. In a
coding run that answer is often the whole task, so a message may only arrive near the end; to steer
the agent mid-task, interrupt.

On a native run, a message reaches the agent before its next model turn. An interrupt stops the
reply it is writing at once; a tool call that is already running finishes first, and the turn's
remaining tool calls are skipped.

The agent is told that a joined message comes from a person whose access Wardby checked, so it
follows the message like a request from whoever gave it the task, within its own instructions.

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
   to send it; start it with `/interrupt` (or `/i`) to interrupt. `/agent` shows the agent (model;
   its tools, MCP servers, subagents, datastores and secret names, never secret values; its
   repositories, and whether a coding run loads the repository's skills) and the run (budget and
   spend, turns, time left, who is joined) and `/prompt` the agent's
   system prompt; both need execute access to the agent, as joining does. `/leave` (or `/exit`)
   leaves (the run finishes its work); `/quit` stops the agent after asking you to confirm:
   the run then ends cancelled and its work is not pushed. Ctrl-C leaves, as
   `/leave` does. After leaving, the chat keeps showing the run until it
   ends; press Ctrl-C (again) to stop watching. A line that is only
   a `/word` is always a chat command, so an unknown one is never sent to the
   agent; a message such as "/tmp is full" is sent as usual.
   In a terminal the chat is coloured; set `NO_COLOR` to turn colour off.

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
`off`. Coding runs also need the control plane's run-steps listener (`WARDBY_RUN_STEPS_LISTEN`) and
the coding proxy's `WARDBY_RUN_STEPS_URL`. A native sandbox run asks the native gateway for
messages, so set `WARDBY_RUN_STEPS` on the gateway as on the server. See [Run steps](run-steps.md).

## Errors

- [`run_not_running`](errors/run-not-running.md): the run already finished or has not started.
- [`join_not_supported`](errors/join-not-supported.md): a Codex or Gemini CLI run, or a workflow run.
- [`join_unavailable`](errors/join-unavailable.md): the run keeps no run steps.
- [`run_not_joined`](errors/run-not-joined.md): join before you send.
