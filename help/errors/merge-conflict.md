---
id: errors/merge-conflict
title: Conflict markers remain
summary: A follow-up run left conflict markers in a file the target-branch merge conflicted, so nothing was pushed.
audience: operator
tags: [error, coding-agents, vcs, merge-conflict, pull-requests]
appliesTo: ">=0.7.0"
---

# Conflict markers remain

A follow-up run on a wardby pull request merges the pull request's target
branch into the branch before the agent starts (see
[Fix merge conflicts on a wardby pull request](../fix-merge-conflicts.md)).
When that merge conflicts, the agent is given the conflicted files to
resolve. A run that finished while one of those files still held a
`<<<<<<<` … `>>>>>>>` marker pair stops with failure category
`merge_conflict` (error `vcs_conflict_markers_remain`), and nothing is
pushed: the pull request is unchanged.

Only the files the merge conflicted are checked, so marker-like lines in
other files (test fixtures, documentation about merging) never trigger this.

## What the requester sees

The run's status comment on the pull request names the file, for example:

> `src/app.ts` still has conflict markers after merging this pull request's
> target branch, so none of its changes were pushed. Ask again to resolve the
> conflicts.

A lead agent that delegated the follow-up sees the sub-run's error code
`coding_failure_merge_conflict`.

## What to do

- Ask again on the pull request (for example "please fix the merge
  conflicts"). The next follow-up merges the target again and gives the agent
  the same list.
- If the conflicts are too large for the agent's budget or turn limit, raise
  them for that agent, or resolve the conflicts by hand and push.
- An agent that keeps stopping early may need instructions that put
  resolving the listed conflicts first.
- A conflict in a path this agent may not edit cannot be resolved by the
  agent (resolving it is an edit, which is refused): resolve that file by hand
  and push.

Related: [Run changed a protected path](protected-path.md),
[Target branch could not be merged](target-merge.md).
