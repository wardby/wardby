---
id: troubleshooting/debugging-agent-runs
title: Debug an agent run
summary: Triage a run that failed, opened no pull request, or missed what you expected, using the MCP tools and GitHub without server logs.
audience: operator
tags: [debugging, triage, get_run, list_runs, failureCategory, diagnosticId, get_run_transcript, no_changes]
appliesTo: >=0.7.0
---

# Debug an agent run

Find the run with `list_runs`, read it with `get_run`, then follow what you see.

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

The full guide is [Debugging an agent run](../../docs/debugging-agent-runs.md).
