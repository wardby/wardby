---
id: errors/run-not-running
title: Run is not running (run_not_running)
summary: Only a running run can be joined or sent messages.
audience: operator
tags: [error, join, join_run, send_to_run, run_not_running]
appliesTo: ">=0.10.3"
---

# Run is not running

`run_not_running` (HTTP 409). The run already finished, was stopped, or has not started yet. Check its status with `get_run`. Start a new run with `trigger_agent` and join that one.

See [Join a running coding run](../join-runs.md).
