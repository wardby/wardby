---
id: errors/vcs-result-history-invalid
title: Result history is not acceptable (vcs_result_history_invalid)
summary: The commits a git-history run returned do not connect to the run's base and its remotes in an allowed way, so none were imported.
audience: operator
tags: [error, coding-agents, vcs_result_history_invalid, git history, result bundle, merge]
appliesTo: ">=0.9.13"
---

# Result history is not acceptable

Wardby checks the shape of the returned commits before it imports them.
`vcs_result_history_invalid` means one of these failed:

- the run's base commit (or, on a continuation, the target-merge commit) is not
  an ancestor of the result;
- a new commit has a parent that is not another new commit, the base, or
  exactly the fetched tip of one of the run's remotes (an older commit of the
  remote does not count);
- a new commit has no parent (an unrelated root);
- a commit could not be read or rewritten.

The run fails in the `workspace` category and nothing is pushed. The usual
causes are the agent rewriting history below the base (`git reset`, a rebase
onto something else, or an orphan branch) or merging a commit the run never
had. Ask the agent to build on the branch it started from and merge only a
remote's tip, then trigger again.

See [Git history in coding runs](../git-history.md).
