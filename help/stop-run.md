---
id: stop-run
title: Stop or cancel a run
summary: Use stop_run to stop a pending, queued, or running run and its in-flight sub-agent runs; it ends as cancelled.
audience: operator
tags: [runs, stop run, cancel run, stop_run, cancelled, schedules, coding-agents, native-agents, sandbox]
appliesTo: ">=0.7.0"
---

# Stop or cancel a run

Call the MCP tool `stop_run` with the run's id to stop a run that has not
finished. Add an optional `reason`; it is recorded on the run.

```text
stop_run {"runId": "<run id>", "reason": "unwanted scheduled run"}
```

Find the id with `list_runs` (filter with `"status": "pending"` or
`"running"`). To stop a schedule from creating more runs, disable it with
`disable_schedule` as well; `stop_run` stops one run, not the schedule.

## What happens

The run ends as `cancelled`, with `Stopped by <your id> with stop_run: <reason>`
in its `stopRequestReason` (and, for a native run, in its `error`).

| The run is                                 | `stop_run`                                                                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending, or a coding run queued for a slot | Ends it now. It never starts.                                                                                                                                                                                  |
| A running native run in the control plane  | Ends it now; the run stops at its next step (the model turn or tool call already under way finishes first).                                                                                                    |
| A running native run in the sandbox        | Ends it now and ends its gateway session, so the worker's next call is refused and it exits. A worker still running after a short grace (5 seconds) is killed and removed; a warm pool worker is never reused. |
| A running coding run                       | Ends it, cancels its model proxy session, and stops and removes its worker. It opens or updates no pull request afterwards.                                                                                    |
| Already finished (any other status)        | Changes nothing and returns its status. Calling `stop_run` again is safe.                                                                                                                                      |

Sub-agent runs the stopped run delegated, and that are still pending or running,
are stopped too (their ids are in `stoppedChildRunIds`).

Spend already recorded stays counted against the budget. A stopped run is not a
failure: Slack notifications say it was cancelled, and no defect is filed.

If the result still shows `pending` or `running`, the stop has been recorded
but has not landed yet; check again with `get_run`.

## Who can stop a run

You need the `runs:trigger` scope and `execute` access to the run's agent, the
same as `trigger_agent`. The agent's owner can stop any of its runs, including
scheduled ones; anyone else can stop only runs they triggered. A run you cannot
see returns `Run "<id>" not found.`, exactly like a missing one; a run you
triggered but whose agent you can no longer execute returns a 403.

## Related

- [Operate managed agents](operating-agents.md)
- [Run native agents in a sandbox](native-sandbox.md)
- [Slack notifications](slack-notifications.md)
- [Run lost](errors/run-lost.md), for runs a deploy interrupted
