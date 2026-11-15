---
id: continue-coding-run
title: Continue a coding run with trigger_agent (continuePriorRun)
summary: Ask a coding agent to keep working on the branch of one of its earlier runs, its pull request or a local repository's pushed wardby/run-<id> branch, instead of starting fresh.
audience: operator
tags: [coding-agents, trigger_agent, continuePriorRun, continuation, follow-up, local, pull-requests]
appliesTo: ">=0.9.15"
---

# Continue a coding run with trigger_agent

`trigger_agent {"agentId": "<coding agent id>", "continuePriorRun": "<run id>", "task": "..."}`
starts a run that continues an earlier run of the same coding agent. The new
run works on that run's branch, in that run's repositories, and pushes its
commits there:

- **A GitHub or Bitbucket repository:** the branch of the pull request the
  earlier run (or the run it continued) opened. The pull request is updated
  in place; no new one is opened.
- **A local repository** (`local:/abs/path`): the branch
  `wardby/run-<root run id>` the earlier run pushed into the repository. The
  branch is fast-forwarded. See [Use local git repositories](local-repositories.md).

The run id can be the first run or any later continuation of it: every
continuation works on the first run's branch. It behaves the same on every job
launcher (Docker, Kubernetes, Substrate).

Rules:

- Only the agent's **owner** can pass `continuePriorRun`, and only for a
  **coding** agent (`continuation_requires_coding_agent`).
- The earlier run must belong to the same agent and must have **finished**
  (any end state: succeeded, failed, budget exhausted, cancelled or lost).
- Leave `baseRef` and `repositories` out: a continuation always works on the
  first run's branch and in its repositories. `repository`, when given, must
  be the first run's repository.
- `task` is the new instruction; leave it out to use the agent's default task.

A refusal is returned before any run starts, and its message begins with a
fixed code. See [Continuation refused](errors/continuation-refused.md) for each
code, and [No pushed branch to continue](errors/no-pushed-branch.md) for
local repositories.

A lead agent continues a run the same way through its `delegate_to_<name>`
call's `continuePriorRun`, and mentions on a pull request and review fix
rounds continue it automatically. See
[Automatic review fix rounds](review-fix-rounds.md).
