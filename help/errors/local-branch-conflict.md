---
id: errors/local-branch-conflict
title: Run's branch was modified or is checked out
summary: The run's wardby/ branch moved since the run started, or it is checked out in the local repository, so wardby did not push to it.
audience: operator
tags: [error, local-repositories, coding-agents, vcs]
appliesTo: ">=0.5.0"
---

# Run's branch was modified or is checked out

`local_branch_conflict` means wardby would not push a run's commit into the
local repository because the target branch (`wardby/<name>`) is not in the
state the run expects. Either:

- the branch moved after the run cloned it, for example you or another run
  committed to it, so the push would not be a fast-forward; or
- the branch is checked out in the repository, and wardby never changes the
  branch you have checked out.

The run fails and nothing is pushed. Your repository, working tree and checked-out
branch are unchanged.

## What to do

1. Check what is checked out: `git -C /path/to/repo branch --show-current`. If
   it is a `wardby/*` branch, switch to another one, such as `main`.
2. If the branch moved, decide which work to keep. To build on the moved branch,
   start a new run with `baseRef` set to that branch so it starts from the
   branch's current tip.
3. Start the run again.

To avoid this, treat `wardby/*` branches as wardby's while a run is active:
do not commit to them or check them out. To inspect a result, use
`git show <branch>` or create your own branch from it.

Related: [Local git repositories](../local-repositories.md).
