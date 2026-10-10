---
id: related-pull-requests
title: Related pull requests across repositories
summary: Wardby lists the other pull requests from the same request in each pull request's description, in the merge order the delegating agent set (mergeOrder) or else a suggested merge order.
audience: operator
tags: [github, pull-requests, multi-repo, merge-order, related, siblings, continuePriorRun, coding-agents, jira]
appliesTo: ">=0.4.2"
---

# Related pull requests across repositories

When one request produces pull requests in several repositories — a lead
agent that delegates to one coding agent per repository, or several runs for
the same Jira issue — Wardby adds a **Related pull requests** section to each
of those pull requests' descriptions. It lists the others with links and
their state, names the originating issue when there is one, and gives a
merge order: the one the delegating agent set, or else a suggested one.

Without a tracked Jira issue, the list covers the pull requests opened by
runs in the same delegation tree (the same lead run and everything it
started). With a tracked issue, the list covers every pull request Wardby
has recorded for that issue across every run, merged and closed ones
included, plus that run tree's own siblings.

- **Written by Wardby, not the model.** The list comes from Wardby's own run
  records, never from the agent's text. Edits you make inside the section
  are replaced on the next rewrite; text outside it is left alone.
- **When.** A pull request already lists the ones opened earlier in the same
  request when it is opened. When the lead run finishes, Wardby rewrites the
  section on every open pull request of the request with the full list and
  current states. A later run that pushes to any pull request in the set
  refreshes the section on all of them the same way, and never removes it.
  With Wardby 0.6.0 or later, a reviewer linked to one of these pull requests does
  not review it until that same lead run finishes, however it ends. When the
  lead finishes normally the section has already been rewritten by then;
  when it is ended another way, such as being cancelled, reviews start
  without that rewrite, so reviewers should rely on `repo_pr_read`'s
  `relatedPullRequests` either way — see [Reviewing a pull request a
  delegated run
  opened](code-review-agents.md#reviewing-a-pull-request-a-delegated-run-opened).
- **Merge order.** Without a `mergeOrder` (see below) on any pull request in
  the set, open (and draft) pull requests are numbered as a **Suggested merge
  order (the order Wardby's agent opened them in)** — delegation order, not a
  dependency analysis, and only reliable when the lead delegates repositories
  that own shared data first (see
  [Fanning out to several builders](../docs/agent-recipes.md#fanning-out-to-several-builders)).
  When any pull request in the set has a `mergeOrder` (open, merged or
  closed), the open ones that have one are numbered under **Merge order (set
  by the delegating agent; equal steps can merge in either order)** and
  labelled "step k of n" (equal values share a step and merge in either
  order relative to each other), and any open pull request without one is
  listed after under "Not ordered:". If only merged or closed pull requests
  have a `mergeOrder`, every open one is listed under "Not ordered:" and the
  "Merge order" heading is left out. Steps are counted over the whole set,
  merged and closed pull requests included, so "step 2 of 3" keeps its label
  after step 1 merges. Either way, check it before merging — neither is a
  guarantee. Merged and closed pull requests follow in a separate "Already
  merged or closed" list, as context only, with their step label when they
  have one.
- Only open pull requests that Wardby's own GitHub App opened are edited;
  merged or closed ones are listed but never changed, and a pull request
  from a different Wardby deployment sharing the same App is never touched.
- **Repository names are visible across the set.** The section (and the
  follow-up hints below) lists every pull request in the set by repository
  name and number, so a request that spans repositories of different
  visibility can show a private repository's name in a public repository's
  pull request. If you mix public and private repositories, keep such work in
  separate requests: separate Jira issues, or separate lead agents.

Reviewers see the section in the pull request description, so a reviewer
agent can tell that a field, route, or schema a change relies on is added by
a sibling pull request rather than missing. Because the description is only
rewritten at the points above, a sibling opened (or merged, or closed) since
then can be missing from it or shown with an old state. With Wardby 0.6.0 or later,
`repo_pr_read`'s `relatedPullRequests` field lists the request's pull
requests fresh on every call instead, so a reviewer should prefer it over
the description's section when they disagree. Its entry for the pull request
just read always carries that pull request's live state; another entry
carries a state only when Wardby has one stored (pull requests linked to an
issue) and omits it otherwise, so call `repo_pr_read` on that pull request
for its live state. `relatedPullRequests` is empty for a pull request on a
local repository, which has no App-authored marker to resolve the request
from. See the
reviewer step in
[Run GitHub code-review agents](code-review-agents.md#ci-and-sibling-pull-requests).

## Setting a merge order

A lead agent sets the order explicitly by passing `mergeOrder` on its
`delegate_to_<name>` call to a coding sub-agent: an integer from 1 to 99,
where 1 merges first. Give a repository that other repositories' changes
depend on a lower number than the ones that use it — for example a shared
service `1`, the API that calls it `2`, the client that calls the API `3`.
Give two changes the same number when there is no order between them; they
share a step and either can merge first. A bad value (not an integer, or
outside 1-99) is refused as a tool error, not silently dropped or clamped.

Set it whenever one request's change spans several repositories and the
pull requests need to land in a specific sequence; leave it out and the set
keeps the delegation-order suggestion above. `mergeOrder` applies only to
coding sub-agents, since only a coding run's pull request can be ordered: a
native sub-agent ignores it, and its tool result notes that it did.

Each pull request shows the value most recently set for it, by the run that
opened it or a later continuation of it. A `continuePriorRun` call that
omits `mergeOrder` keeps that current value, so a follow-up does not need to
repeat it to keep a pull request in its place; one that sets `mergeOrder`
replaces it.

With Wardby 0.6.0 or later, once a set has more than one `mergeOrder`, each
open or draft pull request Wardby opened in it also gets a check run named
`wardby merge order`, tracking whether the pull requests it depends on have
merged yet. It's an informational check by default; search help for "merge
order check" for its states and for requiring it in branch protection.

## Follow-up runs and sibling pull requests

When someone asks for a follow-up on one of these pull requests (an
`@<app-slug>` mention, or a new Jira event on the issue), the task given to
the agent also lists every **open** sibling pull request in the set, with
its link and the exact `continuePriorRun` value that continues it, together
with guidance not to open a duplicate pull request in a repository that
already has one open for this request. Automatic review fix rounds get no
such hints: a fix round's task names only its own pull request. Merged and
closed pull requests are never listed as continuable: a change there needs a
new pull request, which joins the set once it is recorded.

Give your own delivery or router agent's system prompt a line such as:

    Continue the pull request you were asked about, and any listed open
    sibling the change requires; never open a new pull request in a
    repository that already has an open sibling for this request.

The usual limits still apply: `maxDelegationsPerRun` and never delegating to
the same sub-agent twice in one run; every push to a sibling pull request
gets its own review; fix rounds are capped per pull request and only one
runs at a time on a pull request; and a continuation only ever reaches a
sub-agent that shares the same owner as the one asked to continue it.

A continuation never pushes to a pull request that has been merged or closed
in the meantime: the coding run stops before it starts work (or right before
it pushes) with failure category `continuation_closed`, and the delegating
agent is told to make the change as a new pull request instead. See
[Continuation's pull request is no longer open](errors/continuation-closed.md).

Wardby also keeps the recorded state of issue-linked pull requests current
even when GitHub's merge or close webhook delivery was missed: it re-checks
open ones in the background, at most ten at a time, each at most every ten
minutes, and applies the same comment and status move a normal webhook would
have triggered.
