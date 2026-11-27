---
id: agent-flows
title: See how your agents work together (flows)
summary: list_agent_links returns the agents you can read, how they link (delegation, pull request review, fix rounds, after-merge, Jira status hand-offs) and how they start, grouped into flows. The Claude Code pane's Agents tab draws them.
audience: operator
tags: [flows, agent links, list_agent_links, agents tab, sub-agents, review fix rounds, jira statuses, approval]
appliesTo: >=0.9.14
---

# See how your agents work together

A **flow** is a group of agents that hand work to each other. Wardby works flows out from settings
you already have; there is nothing new to configure.

| Link           | Comes from                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Delegates      | A sub-agent edge (`attach_subagent`)                                                                                   |
| Reviews        | A coding agent that can write to a repository, and an agent with the `pull_request` trigger on it                      |
| Fix rounds     | A reviewer on a repository, and an agent with the `review_fix` trigger on it (up to `reviewFixMaxRounds`, default 2)   |
| After merge    | A coding agent that can write to a repository, and an agent with the `push` trigger on it                              |
| Status         | An agent that can move a Jira ticket to a status, and an agent on the same project that starts on it (see below)       |
| Routes reviews | A writer or planner with a `reviewRouter`, and that router (see [Route work from reviews](route-work-from-reviews.md)) |

Each agent's entry points are listed too: `mention`, a Jira project with triggers, a status only a person sets, a schedule, a
webhook, or `manual` (a router always has `manual`: people start it with `request_work`). A reviewer or after-merge agent whose pull requests or merges come from
people, not from a coding agent you can see, gets `pull_request:<repo>` or `push:<repo>` (for
example `pull_request:github:your-org/your-repo`): it starts when a pull request is opened or a
change is merged there. An agent's notes also name the MCP servers it uses (`mcp:<server>`) and the
run hooks on it (`runHook:<event>`, or `runHook:all` for a hook with no event filter).

## Jira statuses

A ticket can carry work between agents. An agent can move a ticket to the statuses in its
`allowedTransitions`, and to its `onPullRequestOpened` and `onPullRequestMerged` statuses. When
another agent on the same project has the `transitioned` trigger with that status in
`triggerStatuses`, the two are linked with the status as the label. Status names match without
regard to case.

A trigger status that no agent on the project can move a ticket to is one only a person sets, such
as an approval column. It is listed as the agent's entry point, `status:<provider>:<project>:<status>`
(for example `status:jira:SCRUM:Approved`).

Agents that a project starts, or that move its tickets, are in the same flow even when a person
moves the ticket between them. A flow with no repository is named after its project ("Jira SCRUM"),
and every flow lists its projects in `issueProjects`.

## Related agents

Agents that only share a repository, with no trigger between them, are not joined into a flow. An
agent in no flow that shares a repository or budget group with one, or its lead's name prefix, is
listed as **related**: a guess, shown separately.

## In Claude Code

The wardby-runs pane's **Agents** tab draws your flows: a list grouped by flow, and for each agent a
Detail tab and a Flow tab with the map. In the terminal the Flow tab is a tree. **Open larger**
(w in the terminal) opens the map in your browser at full size, as a snapshot. See
[The Claude Code run pane](claude-code-run-pane.md). Allow `mcp__<server>__list_agent_links` and
`mcp__<server>__get_agent` for it in auto mode.

The tab needs wardby 0.9.14 or later on the server. On an older server it lists your agents with
`list_agents`, then calls `list_subagents` and `list_repositories` for each one (up to 30 agents;
with more, it shows "Drawing flows needs wardby 0.9.14 or later."). Allow
`mcp__<server>__list_subagents` and `mcp__<server>__list_repositories` too for that.

## With MCP

`list_agent_links` (scope `agents:read`) returns `agents`, `edges`, `flows`, `unlinked` and
`hidden`. Admins can pass `all: true` (needs `admin:view`). It returns link facts only: never
secret values or names, webhook secrets, Jira account ids or JQL. A link to an agent you cannot
read is counted in `hidden`, never named.
