---
id: errors/native-run-timeout
title: Native run passed its time limit (native_run_timeout)
summary: A native agent run in the control plane was still going at its time limit (the agent's timeoutSec) and failed.
audience: operator
tags: [error, native-agents, timeoutSec, native_run_timeout, run timeout]
appliesTo: ">=0.11.3"
---

# Native run passed its time limit

`native_run_timeout` means a native agent run was still going when it reached its time limit, so it
failed. The limit is the agent's `timeoutSec` (default 1800 seconds, 60 to 3600) when the run was
created, counted from then; a run that waited in a queue past it fails before it starts, without
spending anything. Tool calls in progress are stopped, and the cost spent so far stays recorded.

A run in a sandbox fails with
[`native_sandbox_deadline_exceeded`](native-sandbox-deadline-exceeded.md) instead.

1. If the work needs longer, raise the agent's `timeoutSec` with `update_agent`.
2. Otherwise look for a tool that waits a long time, or a task that keeps the agent busy for many
   turns, and split the work into smaller runs or sub-agents.
3. If people joined the run (see [Join a running run](../join-runs.md)), the run waits for their
   messages until the last person leaves; it stops waiting a minute before the limit, so this error
   means the agent itself was still working.
4. Trigger the run again.
