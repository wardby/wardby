---
id: status-comments
title: Run status comments
summary: Read GitHub and Jira run outcomes, package registry blocked statuses, and Slack notifications.
audience: operator
tags: [status, comments, github, jira, slack, blocked, packages, mentions]
appliesTo: >=0.2.1
---

# Run status comments

Mentioning the GitHub App starts a run and posts a working status comment.
The comment is updated when the run finishes, with pull request links, an
answer, or a failure. This includes a run that a deploy moved to a new
control-plane process. Jira requests also report their outcome in a status
comment.

When coding sub-runs record package refusals and no pull request or pushed
changes result, the comment shows ⛔ **Blocked by the package registry: no
changes were made.** It lists refused packages, registry codes, and fixes.
Slack notifications use the same blocked wording. Lists are limited to ten
distinct entries with a count of remaining refusals; use `get_run` for all.
When changes were pushed despite refusals, the pull request link stays and
there is a ⚠️ dependency install warning. Without refusals, the usual ✅
success or ❌ failure wording remains.

An approver can update the coding agent's package allowlist or policy with
`update_agent` (requires `packages:approve` or `agents:admin`), then mention
`@wardby` again. See [Package refusal errors](errors/package-refusals.md) for
code-specific fixes and [Approve packages for coding agents](coding-packages.md)
for policy details. Malware checks cannot be bypassed.
