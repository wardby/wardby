---
id: troubleshooting/budgets
title: Troubleshoot budgets and reservations
summary: Diagnose run refusals caused by an exhausted agent, shared budget group, or sub-agent run tree.
audience: operator
tags: [budgets, reservations, refusals, scheduling]
appliesTo: >=0.2.1
---

# Troubleshoot budgets and reservations

Wardby reserves budget when it dispatches a run. The reservation is limited by
the agent's `budgetUsd`, the remaining shared daily, weekly, or monthly budget
group capacity, and the remaining parent run-tree capacity for a sub-agent.

When no capacity remains, Wardby records the run as refused and does not start
a worker. Common errors include `budget_group_exhausted:day`,
`budget_group_exhausted:week`, `budget_group_exhausted:month`, and
`run_tree_exhausted`.

Inspect the agent, its budget group, and recent runs before increasing a limit.
In-progress runs retain their unspent reservation, so overlapping scheduled,
webhook, and manual runs share one cap rather than each assuming the full
remaining balance.

A run's spend is recorded as it goes, not only when it finishes. A sub-agent
dispatched partway through a run therefore gets the run tree's capacity minus
what the parent (and any earlier sub-agents) have already spent, so a parent
that spends heavily before delegating can leave a sub-agent refused with
`run_tree_exhausted`.

Sub-agents started together (a lead with `parallelDelegations`) also count each
other's unspent reservations, so the last one admitted can be refused with
`run_tree_exhausted` even though no sub-agent has spent much yet. If a
sibling is still running when that happens, the refused sub-agent waits for
it to finish and retries instead of failing immediately — up to roughly
twice its normal wait bound in total; with no sibling running, the refusal is
immediate. A sub-agent that is waiting for budget still counts toward the
lead's `maxDelegationsPerRun`, so a delegation beyond the limit is refused
with `already_dispatched` and a message naming how many delegations were
made and how many are waiting for budget.

For a shared-group refusal, read [Budget group exhausted](../errors/budget-group-exhausted.md).

To see exactly which limit stopped a run and with what numbers, read
`budgetEvents` in `get_run`; see the help article `errors/budget-exhausted`.
A lead and the sub-agents it starts in the same budget group hold the lead's
budget once (or its live sub-agent runs' unspent holds, if the lead's overrun
let them be topped up past it), and `get_budget_group` reports `heldRuns` for
each period.

A coding run's per-request holds price the cached part of the input at the
cache-read rate after the first reply of a conversation; see the help article
`errors/budget-exhausted`.

## Allowing a small overrun

If coding runs stop just short of finishing, set `allowedOverrunPercent` (0 to
100, default 0) on the coding agent so a run may spend that percent beyond
`budgetUsd`. Set it on a lead agent that delegates to raise its run tree's
ceiling for coding sub-agents; native runs' own model calls are not affected.

The overrun is not reserved. A run reserves its base budget, and is topped up
toward its limit while it works, only from room its budget group and run tree
have at that moment. Budget group and run-tree caps stay hard: in a full group
the run stops at its base, and its budget sentence says so ("Its 10% allowed
overrun wasn't available because the "team" group had $0.40 left of its daily
cap."). `get_run` shows `budgetBaseUsd`, the limit in `budgetLimitUsd`, and what
has been granted so far in `budgetReservedUsd`. A run still stopped for budget
keeps its work as a draft pull request you can continue. See
`errors/budget-exhausted`.
