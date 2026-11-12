---
id: status-comments
title: Run status comments
summary: Read GitHub and Jira run outcomes, package registry blocked statuses, and Slack notifications.
audience: operator
tags: [status, comments, github, jira, slack, blocked, packages, mentions, checks, tests, test-first, expected-failure, expected_failure, skipped]
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

## Checks a coding run reports

A coding run lists each check it ran in the pull request description under
**Tests:**, with its outcome: `passed`, `failed`, `expected failure` or
`skipped`. The status comment counts only real failures:

| In the run                                                   | Status comment                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Every check passed                                           | ✅ Opened #N.                                                                    |
| A test-first run that failed on purpose (`expected_failure`) | not counted: ✅ Opened #N.                                                       |
| A check that could not run in the sandbox (`skipped`)        | ✅ Opened #N. 1 check could not be run and was skipped: see the description.     |
| A check that failed                                          | ⚠️ Opened #N, but 1 check failed in the run (and how many were skipped, if any). |

Builders on a worker older than Wardby 0.9.6 can't report `expected_failure`.
A `failed` entry whose label says the failure was expected still isn't
counted, for example `(before fix)`, `(before implementation)`,
`(expected failure)` or `(red run)`. To have a builder report test-first runs
this way, add the rule from the [builder prompt](builder-agent.md#builder-prompt).

When a run opened or updated pull requests in several repositories, the
finished comment lists each one; a mention that arrives while a follow-up for
the change is already running gets a reply to mention again after it finishes
(Several repositories in one coding run (help article `multi-repository-runs`)).

The status comment doesn't read the repository's own CI checks; see the pull
request for those.
