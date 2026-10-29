---
id: fix-merge-conflicts
title: Fix merge conflicts on a wardby pull request
summary: Follow-up runs merge the PR's current target branch first and resolve its conflicts; ask to update a PR that fell behind.
audience: operator
tags: [github, pull-requests, merge-conflict, update-pr, target-branch, continuation, review_fix]
appliesTo: ">=0.7.0"
---

# Fix merge conflicts on a wardby pull request

Every follow-up run on a pull request a wardby coding run opened (a mention on
the PR, a delegated `continuePriorRun`, a review fix round) first brings the
branch up to date with the branch the pull request **currently** targets:

1. Before the agent starts, wardby asks GitHub for the pull request's base
   branch. A pull request retargeted since it opened (a stacked PR whose
   parent merged, a release branch) merges its new base, not the one the
   first run used.
2. wardby fetches that branch from the same repository (never a fork) and
   merges it into the workspace, in trusted code, before the agent sees it.
   A branch that already contains its target is left exactly as it was.
3. **No conflicts:** the agent works on the updated branch as usual.
   **Conflicts:** the agent's task lists the conflicted files and which side
   is which (this pull request's branch, then the target). It is asked to
   resolve every conflict keeping both sides' intent, fix the tests the
   combination broke, and run the repository's checks.
4. The push is one merge commit authored by Wardby, with the pull request's
   head and the target as its parents. It is pushed even when the agent
   changed nothing else, so asking a wardby agent on the pull request to
   "update this PR" or "fix the merge conflicts" is enough.
5. The run's status comment on the pull request says what was merged, for
   example "Merged `main` @ `1a2b3c4` into this branch; resolved conflicts
   in 2 files."

## Ask to update this PR

Mention the wardby agent on the pull request with "please update this PR" or
"please fix the merge conflicts". The follow-up merges the target branch,
resolves any conflicts, and pushes the merge commit.

## What is checked

- **Conflict markers.** A file the merge left conflicted that still holds
  conflict markers when the run finishes stops the push: the run fails with
  category `merge_conflict` and nothing is pushed — see
  [Conflict markers remain](errors/merge-conflict.md).
- **Protected paths and size limits** apply to the agent's own changes,
  measured against the automatic merge: a change the target branch made to a
  protected path is merged as it is, while resolving a conflict in a protected
  path, or reverting the target's change to one, is an edit by the agent and
  is refused as usual (see [Protected path](errors/protected-path.md)).
- **Someone else pushed meanwhile.** The push is still a fast-forward of the
  head the run started from, so a push by anyone else in the meantime fails
  the run the same way it did before, with nothing pushed.
- **No merge base.** A target branch that cannot be fetched, or shares no
  history with the pull request, fails the run before the agent starts — see
  [Target branch could not be merged](errors/target-merge.md).

## Limits

- Local repositories (`local:`) have no pull requests, so a continuation there
  is not merged with anything.
- A conflicted file with no markers (a binary file, or one deleted on one side
  and changed on the other) holds one side's version, or the changed version.
  The agent is told to check it, but nothing stops it from leaving that version
  as it is.
- A conflict in a protected path cannot be resolved by the agent: resolving it
  is an edit to that path, which is refused. Resolve that file by hand and push.

Related: [Run GitHub code-review agents](code-review-agents.md),
[Automatic review fix rounds](review-fix-rounds.md),
[Related pull requests across repositories](related-pull-requests.md).
