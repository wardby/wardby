---
id: errors/join-unavailable
title: Join unavailable (join_unavailable)
summary: The run keeps no run steps, so it cannot be joined.
audience: operator
tags: [error, join, join_run, send_to_run, join_unavailable]
appliesTo: ">=0.11.0"
---

# Join unavailable

`join_unavailable` (HTTP 409). Joining needs run steps: `WARDBY_RUN_STEPS` must not be `off`, the agent's `runSteps` must not be `off`, and the control plane's run-steps listener (`WARDBY_RUN_STEPS_LISTEN`) and the coding proxy's `WARDBY_RUN_STEPS_URL` must be configured. See [Run steps](../run-steps.md).

See [Join a running coding run](../join-runs.md).
