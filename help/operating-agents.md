---
id: operating-agents
title: Operate managed agents
summary: Understand the identity, budget, capabilities, triggers, and result of a Wardby-managed agent.
audience: operator
tags: [agents, budgets, schedules, runs]
appliesTo: >=0.2.1
---

# Operate managed agents

Every Wardby-managed agent has an owner, system prompt, model, per-run budget,
and explicitly attached capabilities. A run starts only when its identity,
policy, and available budget agree.

Create, update, pause, trigger, and inspect agents through Wardby's MCP tools.
The CLI is the bootstrap and operations fallback. Scheduled work requires a
running scheduler: `wardby serve` runs MCP, scheduler, and reconciliation in
one process; `wardby mcp` alone does not execute schedules.

Use [Choose a native or coding agent](creating-agents.md) to select the least
powerful execution model that can safely produce the desired outcome.

Before a run starts, Wardby reserves its allowed spend. The reservation is
constrained by the agent's own budget, any shared budget group, and any
sub-agent run tree. See [Budget troubleshooting](troubleshooting/budgets.md)
when a run is refused for lack of budget, and
[Attribute agent spend to issues](cost-attribution.md) to see what runs cost
per issue, epic, project, agent, or model.

A running run's cost, token counts, and turn count update after each model
call, so `get_run` and `list_runs` show spend so far rather than zero until the
run finishes.

For the full lifecycle and the controls applied to every managed run, read
[`README.md`](../README.md).
