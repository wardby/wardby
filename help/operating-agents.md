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

To see your runs across every agent, call `list_runs` without an `agentId`
(Wardby 0.8.0 and later). Each row names its agent and leaves out the final
text; `active: true` keeps pending and running runs, and `since` (an ISO time)
keeps runs that started or finished since then plus any still active. You see
every run of the agents you own and only the runs you started on the others.
One agent's listing (with `agentId`) also leaves out the final text, returns 50
rows by default and pages with `before`; `get_run` has the final text.
`list_agents` with `summary: true` returns just each agent's id, name, kind,
model, coding provider, budget, owner and your access, without the full
configuration.

From Wardby 0.8.0, `get_run` and `list_runs` without an `agentId` also return
`triggerInfo` (the pull request or issue that started the run, and whether it
was a review or a mention), `outcomes` (pull requests opened, comments, checks)
and `serviceReadiness` (each coding-run service's state). They use the admin
viewer API's shapes. Match one run's pull-request outcome to another run's
trigger to follow a pull request through its review and fix rounds.

To stop a run that is pending, queued, or running (for example one a schedule
started that you did not want), call `stop_run` with its id. It ends as
`cancelled`, along with the sub-agent runs it still has in flight. Search help
for "stop run" (article `stop-run`, Wardby 0.7.0 and later).

For the full lifecycle and the controls applied to every managed run, read
[`README.md`](../README.md).
