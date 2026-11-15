---
id: errors/no-pushed-branch
title: No pushed branch to continue (no_pushed_branch)
summary: A continuation of a local-repository coding run was refused because no run in its chain pushed the wardby/run-<id> branch.
audience: operator
tags: [error, coding-agents, local, local-repo, continuePriorRun, continuation, no_pushed_branch, trigger_agent]
appliesTo: ">=0.9.15"
---

# No pushed branch to continue

A coding run in a local repository (`local:/abs/path`) opens no pull request:
it pushes its result into the repository as the branch
`wardby/run-<run id>`. A continuation of that run (`trigger_agent`'s
`continuePriorRun`, or a lead's `delegate_to_<name>` call) works on that same
branch, so wardby first checks that the branch was pushed: the first run, or
any continuation of it, ended with the branch pushed.

`no_pushed_branch` means none of them did. Usually the first run made no
changes, or it failed or was stopped before it pushed. No run was started and
nothing was spent.

## What to do

- Start a new run without `continuePriorRun`. It creates a fresh branch from
  the agent's base ref.
- To build on a branch that does exist in the repository, pass it as
  `baseRef` instead (for example `baseRef: "wardby/run-<run id>"`). That run
  pushes its own new branch.

Warm rounds on Substrate do not change this: the check runs before any round,
warm or fresh, and a kept workspace does not stand in for a pushed branch.

A continuation that is accepted can still fail later with
[`local_branch_conflict`](local-branch-conflict.md) when the branch moved or is
checked out in your repository. See
[Use local git repositories](../local-repositories.md),
[Continue a coding run](../continue-coding-run.md) and
[Continuation refused](continuation-refused.md).
