---
id: errors/delegation-conflict
title: Delegation conflict
summary: A delegate_to_* call returned delegation_conflict because its call id is already used by a run of another sub-agent.
audience: operator
tags: [error, delegation, sub-agents, runs, delegation_conflict]
appliesTo: ">=0.7.0"
---

# Delegation conflict

`delegation_conflict` is the error a `delegate_to_*` call returns to the model when wardby could not create the sub-agent run: each sub-agent run records the parent's tool-call id, and that id is already used by a run of a different sub-agent of the same parent.

It can happen when two executions of the same delegate step overlap (for example, a stalled process and the process that took the run over). When the other execution already started this sub-agent, wardby waits on that run instead and no error is returned. Only when the existing run belongs to a different sub-agent does the call return `delegation_conflict`.

No new sub-agent run is started, and the parent run is not failed: the model gets the error as the tool result ("The sub-agent run could not be created: its call id is already used by another sub-agent run.") and can report it or try again.

## What to do

1. List the runs of the parent's sub-agents with `list_runs` (by each sub-agent's `agentId`) and look for those whose `parentRunId` is the parent run.
2. Check the server logs for `delegation child create hit a unique key held by no child of this agent`, which names the run and the sub-agent.
3. If the model did not delegate again on its own, trigger the request again.

See [Run lost](run-lost.md) for how runs continue after a restart, and [Native capabilities](../native-capabilities.md) for sub-agents.
