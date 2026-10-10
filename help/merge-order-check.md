---
id: merge-order-check
title: The wardby merge order check
summary: A per-pull-request `wardby merge order` check that tracks whether the pull requests a step depends on, by mergeOrder, have merged yet.
audience: operator
tags: [github, checks, branch protection, merge order, delegation, mergeOrder, pull-requests, related-pull-requests]
appliesTo: ">=0.6.0"
---

# The wardby merge order check

> **Requires Wardby 0.6.0 or later.**

When a delegating agent sets a `mergeOrder` on a request's pull requests
(see [Setting a merge
order](related-pull-requests.md#setting-a-merge-order)), Wardby posts a
check run named exactly **`wardby merge order`** on each open or draft pull
request of that [related set](related-pull-requests.md) that its own GitHub
App opened. The check tells you, per pull request, whether the steps it
depends on have merged yet — so you can tell at a glance, or gate a merge
on it, without reading every sibling pull request's state by hand.

## When it is posted

Only when the pull request's related set has **more than one distinct
`mergeOrder` value** across its members, merged and closed ones included.
A request whose pull requests all share one `mergeOrder`, or carry none at
all, gets no check. A pull request without a `mergeOrder` is never checked
itself, and is never any other pull request's dependency either.

A member with order _k_ depends on every other member of the set with a
strictly lower, non-null order. Members that share the same `mergeOrder`
have no order between them — neither is the other's dependency, and either
may merge first.

## The three states

- **Waiting for earlier steps (`in_progress`)** — one or more dependencies
  (strictly lower `mergeOrder`) have not merged yet. The title reads
  "Waiting for _N_ earlier pull request(s) to merge", and the summary lists
  them by link.
- **Every earlier step has merged (`success`)** — every dependency has
  merged, or the pull request is the set's lowest step and has nothing to
  wait for. The check completes with conclusion `success`.
- **An earlier step was closed without merging (`failure`)** — a dependency
  was closed and never merged. The check completes with conclusion
  `failure` and names the closed pull request(s) in the summary.

Every state's summary also carries a step label, "Step _k_ of _n_ in the
merge order set by the delegating agent," counted over the whole set
(merged and closed pull requests included), so a pull request's step
number doesn't change as earlier steps merge.

### Waiting for the delegating run to finish

While the delegating (lead) agent's run that produced this set is still
running, it may still add or reorder steps. So, for every pull request
above the set's **lowest** step, a would-be `success` is held back: the
check stays `in_progress` with the title "Waiting for the delegating run
to finish" until that run ends, however it ends. Only a lead agent's run
holds later steps this way: a coding run that continues one of the set's
pull requests on its own (a review fix round, or an `@` mention picked up
by a coding link) never does, and its pushes update the check as they
land. The lowest step still
reports `success` right away ("First step: nothing to wait for") — it has
no dependency this hold could change. A pull request already `in_progress`
on an unmerged dependency, or `failure` on a closed one, is reported as
such regardless of whether the delegating run is still running.

## When it is updated

The check is recomputed and reposted, reading every member's current state
live from GitHub:

- when the delegating (lead) agent's run finishes;
- when any pull request in the set is closed or merged;
- on a new head or a reopen of any pull request in
  the set, on every open or draft pull request Wardby's own GitHub App
  opened; and
- by Wardby's own reconciliation sweep (below), for events the first three
  points might have missed.

Reopening a closed, unmerged dependency moves any pull request that was
reported `failure` because of it back to `in_progress` — once that
dependency merges (or another dependency is still unmerged or closed), the
check moves on from there as usual.

### The reconciliation sweep

As a fallback for a missed GitHub event, Wardby periodically re-checks
merge-ordered sets in the background: at most once every 10 minutes per
process, covering the 50 most recently updated coding runs that carry a
`mergeOrder` and were updated within the last 7 days, resolved to their
request's run tree and synced a bounded number at a time, least-recently
swept first, so every covered set is revisited eventually. A set whose
pull requests haven't changed in over 7 days relies on its GitHub events
alone.

## Requiring it in branch protection

Posting the check never blocks a merge by itself — that's opt-in. To make
GitHub refuse a merge until a pull request's earlier steps have merged,
add `wardby merge order` as a required status check in the repository's
branch protection rules (or, on a repository using rulesets, its ruleset's
required status checks): **Settings → Branches** (or **Rules → Rulesets**)
**→ require status checks to pass → `wardby merge order`**. GitHub matches
required checks by name, so it must be exactly that string. Also set the
required check's expected source to your Wardby GitHub App, so a check of
the same name reported by anything else (another App, or a workflow in the
repository — any workflow with `checks: write`, such as one running on a
pull request author's `GITHUB_TOKEN`) cannot satisfy it. A request
without a `mergeOrder` on more than one pull request never posts this
check, so don't require it on a repository whose pull requests are never
ordered this way — GitHub would then wait on a check that never arrives.

See also [Branch protection](../docs/code-review-agents.md#branch-protection)
for requiring a passing _review_ the same way.
