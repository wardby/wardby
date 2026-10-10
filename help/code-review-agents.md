---
id: code-review-agents
title: Run GitHub code-review agents
summary: Link a read-only review agent to a repository for pull-request checks and trusted mention workflows.
audience: operator
tags: [github, code-review, pull-requests, webhooks, ci, checks, waitForCi]
appliesTo: >=0.2.1
---

# Run GitHub code-review agents

A native agent linked through Wardby's GitHub App can review pull requests
without receiving repository credentials. On pull-request pushes it creates an
in-progress check, reads the diff, then posts inline findings, one updated
summary comment, and a final approve, changes-requested, or comment result.
Budget exhaustion or another failed review makes the check fail rather than
silently pass branch protection.

People with write access to the repository may request another review with
`@<app-slug> review`. Other mentions can be routed to a dedicated mention
agent, which acknowledges the request and posts its final outcome. Do not give
a mention agent instructions that could echo secrets or internal details: its
reply is visible wherever the mention was posted.

A mention on a pull request that a wardby coding run opened continues that
run's branch. If this deployment has no record of the run that opened it (for
example, another wardby deployment sharing the same GitHub App opened it), the
App replies that it cannot continue the pull request instead of starting a
run. Ask the deployment that opened it, or change the branch by hand. A
continuation also never pushes to a pull request that has since been merged
or closed — see
[Continuation's pull request is no longer open](errors/continuation-closed.md).

To review a branch of a git repository on the wardby host, without GitHub, see
[Use local git repositories](local-repositories.md).

A repository can also be linked so wardby fixes its own review's findings on
such a pull request automatically, up to a round cap — see
[Automatic review fix rounds](review-fix-rounds.md).

Wardby skips pull requests whose head is in a fork. It also ignores mentions
from bots and people without write access. Repository links require the
agent owner's linked GitHub access, or an explicitly recorded administrator
approval.

## CI and sibling pull requests

`repo_pr_read` also returns `ci`: the CI check runs and commit statuses on the
pull request's head commit (Wardby's own checks left out), an overall state,
and a note. CI is the authority on whether the head builds and passes its
tests. The **Tests** list in a Wardby pull request's description was run in
Wardby's coding sandbox, which may have had an incomplete install (see the
**Dependency install incomplete** warning). Checks still running are reported
as pending.

If a review publishes only a comment while CI on the head is still running (or
has not reported yet), Wardby runs that review again once CI on the same head
has finished, so it can approve or request changes against the real result.
This happens at most once per head commit for each reviewer, only while the pull request is open
and still at that commit, and needs the App's **Check suite** event. CI that
reports only commit statuses (no check suites) does not trigger it, nor does a
commit status still pending when the last check suite finishes; use **Re-run**
on the review check instead.

Commit statuses need the App's **Commit statuses: Read** permission; without
it only check runs are shown.

`repo_pr_read` also returns `relatedPullRequests`: this request's other pull
requests (`repository`, `number`, `state`, `mergeOrder`, `self`), computed
fresh at call time; empty on a human pull request, one with no recognized
Wardby marker, or a pull request on a local repository (no origin marker to
look up there). `state` is `draft`/`open`/`merged`/`closed` for the `self`
entry (the pull request just read) and `open`/`merged`/`closed` for every
other entry. `relatedPullRequests` is current; the PR body's **Related
pull requests** section can be stale — see
[Related pull requests across repositories](related-pull-requests.md).

## Review after CI (`waitForCi`)

A `pull_request` link can set `waitForCi: true` so this reviewer reviews a
pushed head only after that head's own CI has finished, instead of racing
it. The gate below keeps it from approving while CI on that head is known
to be failing or still running; see the gate's own exceptions for when CI
can't be read or this run doesn't own the check.

On a push, Wardby reads CI on the new head before starting a `waitForCi`
reviewer. If CI is still pending, or nothing has reported yet, the review is
held rather than started; it starts once CI finishes (the same **Check
suite** event used for the re-review above), or — if CI never finishes —
after 15 minutes anyway. CI that reports only commit statuses (no check
suites), or a status still pending when the last check suite finishes,
never releases a held review early; it starts only at that 15-minute
fallback. The 15-minute fallback, and the 24-hour drop below, only run
where Wardby's scheduler process runs (`wardby scheduler`, or `wardby
serve` with the scheduler enabled); on an instance running only `wardby
mcp`, a held review starts only once a **Check suite** event arrives, so
with status-only CI it can wait indefinitely. A review still held after 24
hours is dropped. This is decided per pull request, never across a set of
related pull requests.

While CI on the head is failing or still running, `repo_publish_review`
refuses an approve verdict on a `waitForCi` reviewer's own check, returning
a tool error instead of publishing anything:

- `ci_failing` — CI is failing; request changes (or comment) instead.
- `ci_pending` — CI is still running; comment instead. The re-review above
  then runs the review again once a CI check suite finishes.

Requesting changes or commenting is never affected by this gate. When CI
cannot be read at all, the gate is skipped and the review proceeds as it
would without `waitForCi`.

Add this to a reviewer's system prompt:

    Reviewer step (CI and related pull requests). Read `ci` from repo_pr_read.
    When `ci` and the description's Tests disagree, follow CI and say so; never
    ask for a fix only because a sandbox test failed while CI passed. Report
    pending checks as pending. If repo_pr_read's relatedPullRequests is
    non-empty, a field, route or schema the change relies on may be added by
    one of those pull requests: do not report it as missing; note the
    dependency and the listed merge order instead. relatedPullRequests is
    current; the PR body's "Related pull requests" section can be stale.

Wardby also writes that section: see
[Related pull requests across repositories](related-pull-requests.md).

For App permissions, webhook setup, trigger configuration, and security
details, follow [`docs/code-review-agents.md`](../docs/code-review-agents.md).
