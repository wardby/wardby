---
id: errors/native-sandbox-deadline-exceeded
title: Native run deadline exceeded
summary: A sandbox run passed its 60-minute maximum lifetime and its worker was stopped.
audience: operator
tags: [error, native-agents, sandbox, native_sandbox_deadline_exceeded]
appliesTo: ">=0.6.0"
---

# Native run deadline exceeded

`native_sandbox_deadline_exceeded` means the run was still going when it reached the sandbox's maximum lifetime of 60 minutes, so the worker was stopped and the run failed. The limit protects against stuck runs and is not configurable.

1. Look for a tool that waits forever or a loop that does not converge.
2. Split long work into smaller runs, or delegate parts to sub-agents (each is its own run).
3. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
