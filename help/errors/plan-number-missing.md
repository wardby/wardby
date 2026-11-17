---
id: errors/plan-number-missing
title: A planner run needs an issue or a plan number (plan_number_missing)
summary: A coding agent with planDocument was run with neither an issue nor a planNumber, so the plan cannot be named; the run was refused.
audience: operator
tags: [error, coding-agents, plans, plan_number_missing, planNumber]
appliesTo: ">=0.10.0"
---

# A planner run needs an issue or a plan number

`plan_number_missing` means a coding agent with `planDocument` was started with
no issue and no `planNumber`. The plan is named by that number, so Wardby cannot
publish it. Nothing was published. A scheduled planner commits a refused run;
any other caller is refused with no run.

## What to do

- Start the planner from an issue or a comment on one.
- Or pass `planNumber` on `trigger_agent` or on the lead's delegate call.

See [Plan documents](../plan-documents.md).
