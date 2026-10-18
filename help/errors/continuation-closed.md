---
id: errors/continuation-closed
title: Continuation's pull request is no longer open
summary: A run asked to continue a pull request that was already merged or closed, so nothing was pushed.
audience: operator
tags: [error, coding-agents, vcs, pull-requests, continuation, continuePriorRun]
appliesTo: ">=0.4.2"
---

# Continuation's pull request is no longer open

A coding run started with `continuePriorRun` (a mention follow-up, a Jira
issue-event task, or a review fix round) reuses the branch and pull request
the named run originally opened. Before cloning, and again right before it
pushes, wardby asks GitHub whether that pull request is still open. A run
that stopped with category `continuation_closed` got a definite answer that
it is not: the pull request was merged or closed, or GitHub no longer lists
an open pull request carrying that run's marker for the branch. Nothing from
the run was pushed either way, so the pull request (and anyone who merged or
closed it) is unaffected.

One thing besides an actual merge or close can also make the check come back
"no longer found," since it looks for an **open** pull request from the run's
branch with the run's hidden marker still in its description: the hidden
`<!-- wardby:<run-id> -->` marker was removed or edited out of the pull
request's description (wardby relies on it to find its own PR; nothing else
identifies it). Retargeting the pull request to another base branch does not
close it for wardby: the follow-up continues it and merges the new base.

When the pull request was merged or closed **before the run started**, the
check before cloning catches it: the run's status is `refused`, and nothing
was spent beyond setup. When it was merged or closed **while the run was
working**, the check right before the push catches it instead: that run ends
`failed`, having already done its work, and that work is not pushed. Either
way the category (`get_run`'s `codingRun.failureCategory`) is
`continuation_closed`.

This is a safety check, not a flaky one: a transient GitHub failure while
checking (a timeout, a rate limit, a 5xx) is retried once, after a short
wait, and if it still fails, wardby proceeds as though the pull request were
still open rather than stopping the run on an unconfirmed answer — it only
ever refuses on a definite "merged", "closed", or "no longer found" answer.

## What the requester sees

**(a) A parent agent that delegated the continuation** (a router that called
`continuePriorRun`, a Jira or mention follow-up) gets this back as its
sub-run's `refusal`, never the raw error code:

> The pull request this run was asked to continue is no longer open (merged
> or closed), so nothing was pushed. If the change is still needed, delegate
> again without continuePriorRun: it becomes a new pull request from the
> default branch.

**(b) A person watching the request** — the @-mention's status comment, or
the Jira issue comment for an issue-event task — sees a line about the
sub-run instead, without the error code:

> A sub-run was asked to continue a pull request that is no longer open
> (merged or closed); nothing was pushed.

## What to do

If the change is still needed, ask again without `continuePriorRun` (or
without naming the closed pull request). The new run opens a fresh pull
request from the repository's default branch. If the check is wrongly
finding nothing when the pull request is in fact open, check that the
`<!-- wardby:... -->` marker is still in its description, unedited.

Related: [Run GitHub code-review agents](../code-review-agents.md),
[Automatic review fix rounds](../review-fix-rounds.md),
[Related pull requests across repositories](../related-pull-requests.md).
