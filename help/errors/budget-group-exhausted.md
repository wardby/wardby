---
id: errors/budget-group-exhausted
title: Budget group exhausted
summary: Wardby refused the run because the shared budget group has no remaining capacity for the period.
audience: operator
tags: [error, budget, refusal]
appliesTo: >=0.2.1
---

# Budget group exhausted

An error such as `budget_group_exhausted:week` means the agent's budget group
has no capacity left for that period after accounting for actual spending and
active reservations. Wardby refuses the run before model work or a coding
worker begins.

1. Inspect the budget group's `spentUsd`, `reservedUsd` and `heldRuns` values.
   The refused run's `get_run` output lists the cap, spend and holds in
   `budgetEvents`.
2. Inspect active and recent runs that use the group.
3. Wait for the period to reset, cancel unneeded active work, or deliberately
   adjust the agent or group budget.
4. Trigger a new run after capacity is available; a refused run is not resumed
   automatically.

Do not raise a limit merely to clear a refusal without confirming the intended
owner, schedule, and overlapping work. See [Budget troubleshooting](../troubleshooting/budgets.md).

For a coding run stopped mid-run, see the help article `errors/budget-exhausted`.
