---
id: errors/coding-workflow-unavailable
title: A workflow run failed because its script could not be read
summary: The run failed with coding_failure_workflow_unavailable before any model call because .claude/workflows/<name>.js was missing, unreadable or too large.
audience: operator
tags: [error, workflow, coding-agents, coding_failure_workflow_unavailable, coding_workflow_unavailable]
appliesTo: ">=0.10.2"
---

# A workflow run failed because its script could not be read

## What happened

The run's error starts with `coding_failure_workflow_unavailable`, followed by
a diagnostic id. The agent has a workflow (`codingProfile.workflow`), and
Wardby could not read its script, `.claude/workflows/<name>.js`, from the
run's checkout. Nothing was launched and no model call was made.

The control plane log has the reason under the same diagnostic id, as
`coding_workflow_unavailable: <reason>`:

| Reason       | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `missing`    | There's no such file at the run's commit.                                         |
| `symlink`    | The file, or a directory on the way to it, is a symlink.                          |
| `not_file`   | The path is a directory or another non-file.                                      |
| `too_large`  | The script is over 64 KiB, or too large to ship with the rest of the run's input. |
| `not_utf8`   | The file isn't valid UTF-8.                                                       |
| `repository` | `workflow.repository` names a link that isn't one of the run's repositories.      |

## What to do

1. Check that `.claude/workflows/<name>.js` exists on the branch the run uses
   (the agent's `baseRef`, or the link's ref for `workflow.repository`).
2. Make it a regular file of at most 64 KiB.
3. For `repository`, link the repository to the agent and include it in the
   run (see [multi-repository runs](../multi-repository-runs.md)).

See [Run a Claude Code workflow script](../coding-workflows.md).
