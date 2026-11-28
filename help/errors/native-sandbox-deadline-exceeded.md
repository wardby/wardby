---
id: errors/native-sandbox-deadline-exceeded
title: Native run deadline exceeded
summary: A sandbox run passed its deadline (the agent's timeoutSec, at most 60 minutes) and its worker was stopped.
audience: operator
tags: [error, native-agents, sandbox, native_sandbox_deadline_exceeded, timeoutSec]
appliesTo: ">=0.6.0"
---

# Native run deadline exceeded

`native_sandbox_deadline_exceeded` means the run was still going at its deadline, so the worker was stopped and the run failed. From 0.11.3 the deadline is the agent's run time limit, `timeoutSec` (default 1800 seconds), counted from when the run was created; it is never more than the sandbox's maximum of 60 minutes. Before 0.11.3 every sandbox run had the 60-minute maximum. A run in the control plane fails with [`native_run_timeout`](native-run-timeout.md) instead.

1. If the work needs longer, raise the agent's `timeoutSec` with `update_agent` (at most 3600).
2. Otherwise look for a tool that waits forever or a loop that does not converge.
3. Split long work into smaller runs, or delegate parts to sub-agents (each is its own run).
4. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
