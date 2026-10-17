---
id: errors/budget-exhausted
title: Run stopped out of budget (budget_exhausted)
summary: A coding run stopped because its next model request did not fit what was left of its budget; get_run's budgetEvents says which limit and why.
audience: operator
tags: [error, budget, budget_exhausted, coding_budget_exhausted, overrun, allowedOverrunPercent, draft]
appliesTo: ">=0.6.1"
---

# Run stopped out of budget

## What happened

Before each model request the coding proxy holds an amount against the run's
budget. The first request of a conversation (and any fallback) holds the worst
case: the whole request body as new input plus the largest reply the request
allows, priced at the model's output rate. After a mostly cached reply in the
same conversation, the cached part of the prompt is held at the cache-read
rate instead, so the hold is much smaller. A request whose hold does not fit in what is
left is refused, and the run ends `budget_exhausted` (its error reads
`coding_budget_exhausted: <sentence>`). The run stopped before a request whose
hold did not fit. A cache miss can make a settled reply cost more than its
hold, up to its worst case (see [Holds vs actual spend](#holds-vs-actual-spend)).

## Find out why

Call `get_run` and read `budgetEvents`. Each event has:

- `kind`: `refused`.
- `limit`: which cap bound the run.
  - `run`: the agent's own `budgetUsd`.
  - `run-tree`: what the lead agent had left for its whole run tree.
  - `day`, `week`, `month`: the budget group's cap for that period.
- `at`: when it was recorded.
- `details`: for a refused model request, the budget, the amount spent, the
  holds of requests in flight, the refused hold, the model and the turn. For a
  refusal at dispatch, the cap, the amount spent, the amount held and
  `heldRuns`, the number of runs holding budget. A refused model request also
  carries `refusedHoldBasis` (`cached` or `full`) and `refusedHoldCeilingUsd`
  (the worst-case hold for that request). Both also carry
  `groupName` (the agent's budget group, when it has one) and, for a
  `run-tree` limit, `leadAgentName`. A refused model request also carries
  `agentBudgetUsd`, the agent's own `budgetUsd`.

The run's error, and a lead's sub-agent result (in its `budget` field), carry
the same facts as one sentence. Pull request and issue comments and check
summaries show the amounts and the budget group's name only.

## Holds vs actual spend

A hold is not a charge. The run is charged the reply's real cost, and the hold
is released when the reply is settled. A hold is larger than a typical reply
because it must cover the whole output allowance (`maxOutputTokens`), and
because the first request of a conversation, and any fallback, assumes the whole
body is new input. Fallbacks apply when there is no previous reply in the
conversation, the model changed, the previous reply was interrupted or mostly
uncached, the previous request in the conversation was sent more than 5 minutes
earlier, or the body got smaller.

If the cache misses, a reply can cost more than its hold. It is still settled
when it costs no more than its worst case, so a run can exceed its budget by at
most the difference between a request's worst case and its hold, for each
request in flight.

Read `refusedHoldBasis`: `full` means the hold was a fallback, so the next
request in a warm conversation would likely hold less; `cached` means it
already used the cache-read rate, so the budget is simply low for the request.
`refusedHoldCeilingUsd` is the most the request could ever hold.

## What to do

- `run`: raise `budgetUsd` on the agent, set `allowedOverrunPercent` (see
  below), or lower `codingProfile.maxOutputTokens`
  so each request holds less.
- `run-tree`: raise `budgetUsd` on the lead agent; its sub-agents draw on it.
- `day`, `week`, `month`: raise the budget group's cap for that period, or wait
  for the period to reset. See [Budget group exhausted](budget-group-exhausted.md).

A refused run is not resumed automatically; trigger a new one.

## Allowed overrun

A coding agent's `allowedOverrunPercent` (integer 0 to 100, default 0; set with
`create_agent` or `update_agent`, same permission as `budgetUsd`) lets a run
spend up to that percent beyond `budgetUsd`. On a lead agent that delegates,
it raises its run tree's ceiling for coding sub-agents instead; native runs' own
model calls are not affected. The run's limit is `budgetUsd` raised by the percent, trimmed to the room its
budget group and run tree still have, so group caps stay hard and the percent a
run got can be lower than the setting. A delegated run tree's ceiling uses the
lead agent's percent. `get_run` shows `budgetBaseUsd` (before the overrun) and
`budgetReservedUsd` (the limit). The sentence then names both, for example
"this run's $1.00 budget and its 10% allowed overrun ($1.10 in all)".

A worker that finishes is delivered even when it ended over the limit: the run
is `succeeded` and its status comment says, for example, "Spent $1.04, $0.04
(4%) over its $1.00 budget, within its allowed overrun."

## Keeping the work of a stopped run

When a run is stopped for budget and its worker ended cleanly, its changes so
far are pushed as the usual draft pull request (or added to the one it was
continuing). A new pull request's description starts "Stopped at its budget
before finishing; the changes so far are in this draft." A continuation leaves
the existing description alone. The run stays `budget_exhausted` and
keeps its `budgetEvents`. A comment mentioning the App on that pull request,
or on the issue it came from, continues the work with a fresh budget. The pull
request is not marked ready automatically until a later continuation finishes.

A new pull request's description has a `### Task` section quoting the request
that started the run (capped at 4 KiB, mentions defused), so a continuation
knows what the draft was for. While the draft's latest commit is the stopped
run's push, the automatic review is skipped with a neutral check, "Skipped:
stopped at its budget", and no fix round starts. Marking the pull request ready
or pushing a new commit gets a normal review. See
[Run GitHub code-review agents](../code-review-agents.md#drafts-stopped-at-their-budget).

If a push check refuses (protected paths, diff limits, access) or there are no
changes, the run ends as above with nothing pushed. So does a continuation of a
pull request that is no longer a draft (marked ready for review): unfinished
work is never pushed onto it. A worker that crashed, timed out or was stopped
is not kept.

## Interrupted replies

When a reply breaks off before its final usage, the proxy settles the request
at an estimate instead of keeping its whole hold: the usage it already read,
else the run's previous reply's input, else the input part of the hold, plus
the output relayed so far counted high, and never more than the request's
worst case. The
request is flagged as estimated and counted in the run's cost. If the
estimate cannot be computed or recorded, the request keeps its full hold. A run can exceed its budget by at
most the gap between the estimate and the real cost.

## Group holds for delegated runs

A lead and the sub-agents it starts in the same budget group hold the lead's
budget once, at the lead (its reservation minus what the whole tree has spent),
decided per period. `get_budget_group` reports `heldRuns` for each period.

See also [Troubleshoot budgets and reservations](../troubleshooting/budgets.md).
