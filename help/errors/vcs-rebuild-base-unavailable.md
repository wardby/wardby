---
id: errors/vcs-rebuild-base-unavailable
title: Coding checkout could not be rebuilt at its recorded base
summary: A control-plane copy that finished a coding run launched by another copy could not re-clone the exact commit the run started from, so it pushed nothing.
audience: operator
tags: [error, coding-agents, vcs, workspace, rollout, vcs_rebuild_base_unavailable]
appliesTo: ">=0.10.2"
---

# Coding checkout could not be rebuilt at its recorded base

A coding run's git checkout lives on the disk of the control-plane copy that
launched it. If that copy is replaced (a deploy, a node drain, a lost pod),
another copy adopts the run. When the run has changes to push, the adopting
copy clones the repository again and pins the clone to what the launching copy
recorded with the run: the commit the run started from and, for a follow-up
run that merged its pull request's target branch, the target commit it merged
(see [Availability and PodDisruptionBudgets](../availability.md)).

A run ends with failure category `workspace` and the logged reason
`vcs_rebuild_base_unavailable` when that exact base could not be reproduced:

- the base commit is no longer in the repository, for example a force-push
  moved the branch and the old commit was garbage-collected;
- for a follow-up run, the merged target commit is gone, or the target and
  branch no longer share history wardby can find;
- the repository could not be reached for the fetch (a transient host error is
  included; see the control-plane log for the cause).

Wardby never pushes onto a different base: a rebuilt checkout on a moved branch
would produce a diff against code the agent never saw. Nothing is pushed, the
run's pull request is unchanged, and the agent's work in the run pod is removed.

## What to do

- Run the agent again. A new run starts from the branch as it is now.
- If it happens on every rollout for one repository, check whether something
  force-pushes the base branch while runs are in flight.
- Read the control-plane log line for the run's diagnostic id; it carries the
  cause chain, such as the failed fetch.

Related: [Coding workspace lost](coding-workspace-lost.md),
[Target branch could not be merged](target-merge.md).
