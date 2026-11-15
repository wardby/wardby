---
id: errors/substrate-result-missing
title: A Substrate run ended without a usable result (substrate_result_missing)
summary: A coding run on the experimental Substrate launcher collected its workspace but the worker left no valid result for the run, and reported no diagnostic of its own; check the worker's exit code and the result size limits.
audience: operator
tags: [error, substrate, substrate_result_missing, job launcher, coding-agents, result, SUBSTRATE_RESULT_MAX_MB]
appliesTo: ">=0.9.15"
---

# A Substrate run ended without a usable result

`substrate_result_missing` (logged as `job_substrate_result_missing`) means the
workspace was collected, but there was no valid result for the run, and the
worker printed no diagnostic of its own (when it does, that diagnostic, such as
[coding_turn_limit](coding-turn-limit.md), is reported instead). The run fails
with the worker's exit code.

Common causes:

- **The worker exited before writing its result**, for example after a crash.
  Look at the exit code and at the agent bridge's error output, which the coding
  proxy logs for the operator as a `substrate.diagnostics` warning (bounded and
  redacted by exact value; never stored or shown in a run record).
- **The result was too large.** The proxy refuses a result over
  `SUBSTRATE_RESULT_MAX_MB` (16 by default), and the control plane ignores one
  over the coding-output limit (256 KiB).
- **The result did not parse, or was for another run.**

Run it again once the cause is fixed. See
[Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
