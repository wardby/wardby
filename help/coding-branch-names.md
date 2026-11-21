---
id: coding-branch-names
title: Coding branch names
summary: How wardby names the branch a coding run pushes (a name you pass, the issue key, or the run id), how repeats are numbered, and how to continue the same pull request with a later run.
audience: operator
tags: [branches, branch-name, pull-requests, continue, same-pull-request, coding-agents, jira, trigger_agent]
appliesTo: ">=0.10.2"
---

# Coding branch names

A coding run pushes to a branch under `wardby/`. Wardby picks the name when it
creates the run, using the first of these that applies:

1. **A name you pass.** `trigger_agent {agentId, task, branch: "readme-update"}`
   gives `wardby/readme-update`. The name is cleaned to lowercase letters,
   digits and hyphens, at most 40 characters. Typing `wardby/` yourself is fine.
2. **The issue key.** A run started for a Jira issue, or by `trigger_agent`
   with `issue`, gives `wardby/PROJ-123`. Jira's GitHub integration links a
   branch to an issue when the key is in its name.
3. **The run id.** With neither, the branch is `wardby/run-<run id>`.

Only the agent's owner can pass `branch`, unless the owner allows non-owner
overrides (`codingProfile.allowWebhookTaskOverride`). It is valid for coding
agents only.

## Repeats

Names are per repository. If another run in the same repository holds the name
(it is still going, or it pushed a branch), the next one gets `-2`, then `-3`.
A run that failed or changed nothing never pushed, so its name stays free.

## Continue the same pull request

Triggering again with a name or issue an earlier run already used does not open
a second pull request. Wardby adds a commit to that run's branch and pull
request, as long as the earlier run opened a pull request, has the same owner
and is in the same repository.

- To get a separate pull request, pass a different `branch`.
- Passing `baseRef` starts a new branch instead.
- Wardby knows whether a pull request is still open only for issue-linked pull
  requests. For others it assumes it is open, so after closing or merging one
  on the host, use a new `branch` name.

## Related

- [Push the branch without opening a pull request](help://coding-branch-only)
- [Pull request titles and commit messages](help://pull-request-titles)
- [Jira agents](help://jira)
- Operator guide: `docs/coding-agent-setup.md`, section "Branch names".
