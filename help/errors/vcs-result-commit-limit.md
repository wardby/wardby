---
id: errors/vcs-result-commit-limit
title: Too many new commits (vcs_result_commit_limit)
summary: A git-history run made more than 500 new commits in one repository, so none were imported.
audience: operator
tags: [error, coding-agents, vcs_result_commit_limit, git history, result bundle]
appliesTo: ">=0.9.13"
---

# Too many new commits

A run may return at most 500 new commits per repository (commits that are not
already in the base or in a remote's history). More fails the run with
`vcs_result_commit_limit` in the `workspace` category, and nothing is pushed.

Ask the agent for fewer, larger commits (for example, squash its own work), or
split the task. A merge of an upstream does not count the upstream's own
commits, only the merge commit and the agent's commits.

See [Git history in coding runs](../git-history.md).
