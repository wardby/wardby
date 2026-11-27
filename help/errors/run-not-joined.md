---
id: errors/run-not-joined
title: Not joined to the run (run_not_joined)
summary: Join the run with join_run before sending it messages.
audience: operator
tags: [error, join, join_run, send_to_run, run_not_joined]
appliesTo: ">=0.11.0"
---

# Not joined to the run

`run_not_joined` (HTTP 409). Call `join_run` with the run's id, then `send_to_run`.

See [Join a running coding run](../join-runs.md).
