---
id: errors/budget-exhausted
title: Run stopped out of budget (budget_exhausted)
summary: A coding run stopped because its next model request did not fit what was left of its budget; get_run's budgetEvents says which limit and why.
audience: operator
tags: [error, budget, budget_exhausted, coding_budget_exhausted, reservations, holds, prompt-cache]
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
`coding_budget_exhausted: <sentence>`). The run did not overspend; it stopped
before a request it might not have been able to pay for.

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
conversation, the model changed, the previous reply was interrupted, mostly
uncached or more than 5 minutes old, or the body got smaller.

Read `refusedHoldBasis`: `full` means the hold was a fallback, so the next
request in a warm conversation would likely hold less; `cached` means it
already used the cache-read rate, so the budget is simply low for the request.
`refusedHoldCeilingUsd` is the most the request could ever hold.

## What to do

- `run`: raise `budgetUsd` on the agent, or lower `codingProfile.maxOutputTokens`
  so each request holds less.
- `run-tree`: raise `budgetUsd` on the lead agent; its sub-agents draw on it.
- `day`, `week`, `month`: raise the budget group's cap for that period, or wait
  for the period to reset. See [Budget group exhausted](budget-group-exhausted.md).

A refused run is not resumed automatically; trigger a new one.

## Interrupted replies

When a reply breaks off before its final usage, the proxy settles the request
at an estimate instead of keeping its whole hold: the usage it already read,
else the run's previous reply's input, else the input part of the hold, plus
the output relayed so far counted high, and never more than the hold. The
request is flagged as estimated and counted in the run's cost. If the
estimate cannot be computed or recorded, the request keeps its full hold. A run can exceed its budget by at
most the gap between the estimate and the real cost.

## Group holds for delegated runs

A lead and the sub-agents it starts in the same budget group hold the lead's
budget once, at the lead (its reservation minus what the whole tree has spent),
decided per period. `get_budget_group` reports `heldRuns` for each period.

See also [Troubleshoot budgets and reservations](../troubleshooting/budgets.md).
