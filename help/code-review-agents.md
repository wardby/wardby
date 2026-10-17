---
id: code-review-agents
title: Run GitHub code-review agents
summary: Link a read-only review agent to a repository for pull-request checks and trusted mention workflows.
audience: operator
tags: [github, code-review, skipped-review, budget-stopped-draft, continue-draft, follow-up, pull-requests, webhooks, ci, checks, waitForCi, markReadyWhenPassing, repo_issue_read, issues, acceptance-criteria, jira]
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

## When a review starts

A push normally starts a review right away, but its timing can be held back
by two independent things: from Wardby 0.6.0, the pull request's own
delegating request still running (see [Reviewing a pull request a delegated run
opened](#reviewing-a-pull-request-a-delegated-run-opened) below), and, on a
link set up for it, CI on the pushed head still running (see [Review after
CI (`waitForCi`)](#review-after-ci-waitforci) below). Either can delay the
check that reports the review's result; neither changes what the review
itself reports once it runs.

## Drafts stopped at their budget

From Wardby 0.6.1, a pull request that is still a draft, whose latest commit
came from a coding run that stopped at its budget, is not reviewed automatically. Its check
completes as neutral, "Skipped: stopped at its budget", and no automatic fix
round follows. Marking the pull request ready for review or pushing a new
commit starts a normal review, and so does re-running the check or a review
mention. The `budget-exhausted` error article describes how a stopped run keeps
its work.

## Follow-ups on an issue

From Wardby 0.6.1, a mention on a GitHub issue that already has an open pull request Wardby
opened tells the agent that pull request and the run id to pass as
`continuePriorRun`, so the work continues on the same branch instead of
opening a second pull request. Jira issues behave the same way (see
[Run Jira agents](jira.md)). The run message lists up to ten open pull requests
recorded for the issue.

## CI and sibling pull requests

`repo_pr_read` also returns `ci`: the CI check runs and commit statuses on the
pull request's head commit (Wardby's own checks left out), an overall state,
and a note. CI is the authority on whether the head builds and passes its
tests. The **Tests** list in a Wardby pull request's description was run in
Wardby's coding sandbox, which may have had an incomplete install (see the
**Dependency install incomplete** warning). Checks still running are reported
as pending.

From Wardby 0.6.1, a Wardby pull request whose run had package audit mode on
(the `package-audit-mode` help article) carries a caution banner: **Packages outside the allowlist** lists what the
registry installed that the agent's allowlist doesn't cover, and **Served
despite advisories** (in `full` mode) lists versions with high or critical
advisories. Reviewers should check those packages before approving.

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

With Wardby 0.6.0 or later, `repo_pr_read` also returns `relatedPullRequests`: this
request's pull requests (`repository`, `number`, `state`, `mergeOrder`,
`self`), computed fresh at call time; empty on a human pull request, one
with no recognized Wardby marker, or a pull request on a local repository
(no origin marker to look up there). The `self` entry (the pull request just
read) always has a `state` (`draft`, `open`, `merged`, or `closed`) from that
same read. Another entry has a `state` (`open`, `merged`, or `closed`) only
when Wardby has it stored, as it does for pull requests linked to an issue,
and omits it otherwise; call `repo_pr_read` on that pull request when you
need its live state. The list is current; the PR body's **Related pull
requests** section can be stale — see
[Related pull requests across repositories](related-pull-requests.md).

With Wardby 0.6.0 or later, once a set has more than one `mergeOrder`, each
pull request in it also gets its own check run, named `wardby merge order`,
independent of any reviewer link; search help for "merge order check" for
its states and for requiring it in branch protection.

## Reading the issue a pull request resolves

With Wardby 0.7.0 or later, a linked agent also gets `repo_issue_read`: it
reads one issue in a linked repository (title, state, body, labels, author,
and the 30 most recent comments), read-only, so a reviewer can check a pull
request that says `Resolves #N` against the issue's own acceptance criteria
instead of the description's restatement of them. The body is capped at
32,000 characters and each comment at 4,000, with `truncated` flags. A pull
request number is refused (`is_pull_request`; use `repo_pr_read`), a missing
issue is `issue_not_found`, and a local repository has no issues
(`issues_unavailable`). It needs the App's **Issues: Read** permission, which
an App that handles mentions already has. Issue text is untrusted: the agent
treats it as data, never as instructions.

For a pull request that resolves a Jira issue, also link the reviewer to that
Jira project with read access; it then reads the ticket with
`jira_get_issue` (see [Run Jira agents](jira.md)). The quickstart reviewer
prompt reads whichever issue the pull request resolves and says in its
summary when it could not.

## A description wardby can't confirm as its own

With Wardby 0.7.0 or later, when a person has edited a Wardby pull request's
description, Wardby doesn't overwrite it on later runs; it keeps one comment
with the description its latest run proposed, stamped with the commit it
describes. `repo_pr_read` returns that proposal as `descriptionProposal` when
the reviewer reads the pull request, and only for the head being reviewed
(`state: "current"`, untrusted, cut to 16 KB): a description requirement,
such as `Resolves #N` or the issue's acceptance checklist, is met if either
the live description or the proposal meets it. With
`state: "not_for_this_head"`, no proposal for this head exists yet: review the
live description. See
[Automatic review fix rounds](review-fix-rounds.md#description-updates).

## Reviewing a pull request a delegated run opened

This requires Wardby 0.6.0 or later; earlier releases review such a pull
request on its first push. When a lead agent delegates coding work and a sub-agent opens the pull
request (see [Fanning out to several
builders](../docs/agent-recipes.md#fanning-out-to-several-builders)), every
reviewer linked with the `pull_request` trigger holds its review of that
pull request until the delegating (lead) run finishes, however it ends
(including failing, being cancelled or being lost), even if the link has no
`waitForCi` set. This gives the request's other pull requests, if any, time
to open before any of them is reviewed, so a reviewer does not report a
field or route as missing only because a sibling pull request had not opened
yet. When the lead run finishes normally, their **Related pull requests**
sections have also been rewritten (see [Related pull requests across
repositories](related-pull-requests.md)); when it is ended another way, such
as being cancelled, held reviews start without that rewrite. Either way,
reviewers should rely on `repo_pr_read`'s `relatedPullRequests`.

A reviewer linked with `waitForCi` then waits for CI too, once the lead run
finishes, with its own full 15-minute fallback counted from that point. A
pull request opened directly, by a human, or on a local repository is never
held this way. A later request that continues an already-open pull request
is not held again: the request that opened it has already finished (a push
inside the same, still-running request is held). If Wardby cannot tell
whether the pull request's opening run was delegated, the review starts
right away instead. A held review not released when its lead run finishes is
reconsidered by Wardby's reconciliation sweep once it has been held for 15
minutes and released when the lead run has finished, and dropped after 24
hours like a review held for CI.

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

On a release before 0.6.0, `repo_pr_read` has no `relatedPullRequests`:
use the description's **Related pull requests** section in its place in that
step. Wardby also writes that section: see
[Related pull requests across repositories](related-pull-requests.md).

## Mark ready when passing

With Wardby 0.7.0 or later, set `markReadyWhenPassing: true` on the write
link (`link_repository`) of the agent the repository event triggers to have
Wardby mark the draft pull requests it opens here ready for review on its
own, once they pass, instead of leaving that to a person. For a lead that
delegates to a coding builder sub-agent, set it on the lead's link: the
builder needs no repository link of its own, and pull requests its coding
runs open count for the lead. An opted-in agent outside that run tree never
counts. Re-linking the repository without it clears it, like every other
link setting.

Wardby marks a pull request ready once it is open and a draft, Wardby's own
App opened it (and its head isn't in a fork), every authorized reviewer
linked with the `pull_request` trigger has approved the head with its own
check, CI on the head is green (every check run and commit status that
isn't Wardby's own has completed with success, neutral, or skipped, at
least one with success, or there is no CI at all), and the `wardby merge order` check is `success` or
isn't posted on it. Commit statuses only count if the App can read them:
grant **Commit statuses: Read** if your CI reports statuses rather than
check runs. A pull request with more checks and statuses than Wardby reads
(about 50) is never marked ready automatically. Wardby marks a given pull
request ready at most once; moving it back to draft by hand is final —
Wardby never re-marks it.

Wardby checks whether a pull request is ready to mark on any of these
events: a reviewer run finishing, a CI check suite completing on its head,
its `wardby merge order` check turning `success`, or (as a fallback) Wardby's
own reconciliation sweep for a pull request that is part of a merge-ordered
set. With a `mergeOrder` set, a later step becomes ready this way only once
the steps it depends on have merged — see [The wardby merge order
check](merge-order-check.md). CI that reports only commit statuses (no
check suite) is not re-checked when it finishes; such a pull request is
marked ready the next time one of those events fires, or stays in draft
until then.

It never approves, merges, or converts a pull request back to draft — a
person's approval stays the gate wherever branch protection requires one.
It needs no App permission beyond **Pull requests: Read and write**, which
an App that opens pull requests already has.

For App permissions, webhook setup, trigger configuration, and security
details, follow [`docs/code-review-agents.md`](../docs/code-review-agents.md).
