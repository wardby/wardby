---
id: troubleshooting/debugging-agent-runs
title: Debug an agent run
summary: Triage a run that failed, opened no pull request, or missed what you expected, using the MCP tools and GitHub without server logs.
audience: operator
tags: [debugging, triage, get_run, list_runs, get_run_text, get_run_packages, failureCategory, diagnosticId, no_changes]
appliesTo: >=0.7.0
---

# Debug an agent run

Find the run with `list_runs`, read it with `get_run`, then follow what you see.
Without an `agentId`, `list_runs` lists your runs across every agent (from
Wardby 0.8.0); add `active: true` or `since` to narrow it. From 0.9.7, `query`
finds runs at any date by run id, agent name, status, trigger, repository or
branch (not by task text, which can hold secret values).

| What you see                  | What to check                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| No run started                | `list_repositories` on the router: is a link holding the trigger you used?                         |
| Failed or refused             | `status`, `error`, `failureCategory` and the final text. Call `search_help` with the category      |
| Lead ran, no coding run       | The lead's final text, which should say why it didn't delegate                                     |
| Succeeded, no pull request    | `codingResult.outcome`: `no_changes`, `budget_exhausted`, or `branch_pushed` on a local repository |
| Pull request missed the point | The diff, the review, the original request, and `request` on `get_run` (from Wardby 0.8.0)         |

A failed coding run's specific reason is only in the server log. Send an operator
the run ID and its `diagnosticId`. For Claude Code agents with `sessionResume` on,
`get_run_transcript` shows what the agent did; see
[Resume Claude Code runs locally](../resume-runs-locally.md).

Long replies come in pages, so they fit an MCP client's result limit, and
nothing is cut away. `get_run` returns a `request`, `taskOverride`,
`finalText` or `error` longer than 8,000 characters as its first 8,000, with
`<field>More: { next, total }`: call `get_run_text` with the field and
`offset: next`, and again with each `next` until it is `null`. `get_run` gives
a coding run's `packageCount`; `get_run_packages` lists the packages, 200 a
page (pass `next` as `after`). `list_runs` returns 50 rows by default, without
final text, with each task's first 600 characters (`taskOverrideTruncated`),
and pages with `before`, with or without an `agentId`. Both tools follow
`get_run`'s access.

The full guide is [Debugging an agent run](../../docs/debugging-agent-runs.md).
