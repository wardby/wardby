---
id: cost-attribution
title: Attribute agent spend to issues
summary: See what agent work on a Jira card, epic, or project cost, by model and token kind, with the cost_report MCP tool.
audience: operator
tags: [cost, spend, attribution, jira, epic, reporting, cost_report, tokens]
appliesTo: >=0.2.1
---

# Attribute agent spend to issues

Wardby records which issue each run's cost belongs to, so you can see what agent
work on a card, an epic, or a whole project cost.

A run is attributed to an issue when:

- a Jira event on that issue started it;
- it reviews, or answers an `@wardby` mention on, a pull request Wardby opened
  for the issue — including a review that starts while the agent that asked
  for the pull request is still running, before the pull request is linked to
  the issue (Wardby then uses the issue of the coding run that opened it);
- it reviews, or answers a mention on, a pull request opened from a GitHub
  issue: it is attributed to a work item with provider `github` and key
  `owner/repo#N`;
- `trigger_agent` named an `issue`, or a webhook call's JSON body named a
  `wardbyIssue`, as `{ "provider": "jira", "key": "PROJ-123" }`, in a project
  the agent is linked to. Keys are matched without regard to case
  (`proj-123` is read as `PROJ-123`). An unlinked project or a malformed key is
  refused; a webhook answers `400 invalid_issue`. A webhook ignores a
  top-level `issue` field, so forwarded GitHub or Jira payloads still run;
- its parent run is attributed. Sub-agents and coding runs inherit the issue
  and cannot change it.

When a run starts, Wardby records the issue's parent (its epic) as it is at that
moment. Moving an issue to another epic later leaves earlier runs under the
earlier epic. Reports always show the latest known titles.

## Read the report

Call the `cost_report` MCP tool. `groupBy` is `issue` (default), `parent`,
`scope` (project), `agent`, `model`, or `run`; filter with `scopeKey`,
`parentKey`, `issueKey`, `agentId`, `provider`, and an ISO `from`/`to` window
(default: the last 30 days). Drill down by combining them: `groupBy: "parent",
scopeKey: "PROJ"` lists epics, then `groupBy: "issue", parentKey: "PROJ-10"`
lists that epic's cards, and `groupBy: "run", issueKey: "PROJ-123"` gives run
ids for `get_run`.

- Amounts are USD. Tokens are reported by kind — fresh input, cached input,
  cache write, output — because each kind is priced differently; they are never
  added into one total.
- `bySource` splits each row's cost by how its runs were attributed, which
  shows how much was pull-request review (`linked_pr`).
- `unattributed` is spend in the window with no issue. Only `agentId` narrows
  it; the project, epic, and issue filters cannot.
- `totals` sum each run's full cost. With `groupBy: "model"`, rows add up to
  less when some runs have no per-model record.
- You see the same runs as `list_runs`: runs of agents you own, plus runs you
  triggered.

The Jira status comment for a run also ends with its spend: the whole run tree,
the issue's total so far (every attributed run, whichever agent ran it), and the
cost per model.

## Setup notes

If a company-managed Jira site still uses the legacy Epic Link field, set
`WARDBY_JIRA_EPIC_LINK_FIELD` (for example `customfield_10014`) so runs are
grouped under their epic. On GKE, `deploy/gke/up.sh` applies the database
grant coding runs need to record their per-model usage when you upgrade.

For the full guide, follow [`docs/jira-agents.md`](../docs/jira-agents.md).
