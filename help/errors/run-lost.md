---
id: errors/run-lost
title: Run lost
summary: A run ended as lost, usually because a deploy replaced the version that was executing it.
audience: operator
tags: [error, runs, deploy, lost]
appliesTo: ">=0.6.1"
---

# Run lost

A run with status `lost` stopped without finishing and without a result. Read its `error` with `get_run`. The usual cause is a deploy that changed the application version while the run was still going.

## When a deploy does not lose a run

A native run that is waiting in a `delegate_to_*` call on a coding sub-agent, or on a native sub-agent running in `sandbox` mode, is taken over by the new version. It continues when the sub-agent finishes, and the turns it already took are not repeated.

## Reasons

- `Durable workflow belongs to application version <old>; this process runs <new>.` The run was mid-turn, waiting on a tool that is not a delegation, or waiting on a control-plane native sub-agent, so the new version could not take it over.
- `Could not continue across versions: the run's steps changed in the new version.` The run was waiting on a sub-agent, but the new code no longer matches the steps the run had recorded.
- `Durable workflow could not be re-driven after 3 adoption attempts…` Wardby tried three times to resume the run and gave up.
- `Orphaned: no heartbeat/progress since before <time>.` Nothing was executing the run and it stopped reporting progress, for example because its process was killed.

## Sub-agents of a lost run

When a run is marked lost, sub-agent runs it started that are still going are stopped with the reason `parent run lost`. They are not left running for nobody.

A run that continues after a restart of the same version cannot continue a control-plane native sub-agent it was waiting on: that sub-agent ran inside the process that stopped. (After a deploy, a run waiting on such a sub-agent is not taken over at all; it is marked lost, as above.) The sub-agent run is stopped with the reason `parent resumed without it`, and no new one is started. The parent run goes on, and its `delegate_to_*` call returns the error `subagent_interrupted` ("The sub-agent was interrupted by a restart and cannot be resumed; no new sub-agent run was started."), so the model can report it.

If two executions of the same `delegate_to_*` step overlap and the call id is already held by a run of a different sub-agent, the call returns `delegation_conflict` instead; see [Delegation conflict](delegation-conflict.md).

## What to do

1. Read the reason with `get_run`.
2. Trigger the request again. If an `@`-mention started the run, its status comment says the request was interrupted and should be repeated.
3. To lose fewer runs, deploy when few runs are executing. The old version first waits for its runs to finish, up to `SHUTDOWN_DRAIN_SECONDS`; only runs still going after that limit are affected.

See [Operating agents](../operating-agents.md) and the [GKE guide](../../docs/getting-started-gke.md).
