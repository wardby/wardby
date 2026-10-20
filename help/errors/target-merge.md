---
id: errors/target-merge
title: Target branch could not be merged
summary: A follow-up run could not fetch or merge its pull request's target branch, so it stopped before the agent started.
audience: operator
tags: [error, coding-agents, vcs, merge-conflict, target-branch, pull-requests]
appliesTo: ">=0.6.1"
---

# Target branch could not be merged

Before a follow-up run on a wardby pull request starts its agent, wardby
merges the branch the pull request currently targets into the workspace (see
[Fix merge conflicts on a wardby pull request](../fix-merge-conflicts.md)).
A run stops with failure category `target_merge` (error
`vcs_target_merge_failed`) when that could not be done:

- the target branch could not be fetched from the repository (it was deleted,
  or the fetch failed);
- the pull request's branch and its target share no history wardby could
  find: the branches are unrelated, or their common commit is more than about
  5,000 commits back;
- the merge itself failed for a reason other than a content conflict (content
  conflicts are handed to the agent, not failed);
- the git on the machine that runs wardby is older than 2.38, which does not
  support the `merge-tree --write-tree` form the merge uses.

Nothing is pushed and no agent work is lost, since the agent had not started.

## What to do

- Check the pull request's base branch on GitHub. Retarget it if the branch
  it names no longer exists or is not the one it should merge into.
- For unrelated histories, merge the branches by hand once; later follow-ups
  then find the merge base.
- A transient fetch failure succeeds on the next request.
- Upgrade the machine's git to 2.38 or newer (`git --version` shows it).

Related: [Conflict markers remain](merge-conflict.md),
[Continuation's pull request is no longer open](continuation-closed.md).
