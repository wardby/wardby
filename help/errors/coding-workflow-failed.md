---
id: errors/coding-workflow-failed
title: A workflow run failed because its workflow did not complete
summary: The run failed with coding_failure_workflow_failed because the workflow script failed, was stopped or was never started.
audience: operator
tags: [error, workflow, coding-agents, coding_failure_workflow_failed, coding_workflow_failed]
appliesTo: ">=0.10.2"
---

# A workflow run failed because its workflow did not complete

## What happened

The run's error starts with `coding_failure_workflow_failed`, followed by a
diagnostic id. The run's workflow script didn't complete:

- the script threw an error, or one of its steps failed in a way the script
  didn't handle;
- the workflow was stopped;
- the session never started it.

Wardby uses a workflow run's result only after the workflow completes, so a
run whose workflow didn't complete has no result to collect.

## What to do

1. Check the run's steps (`get_run_steps`) to see how far it got.
2. Run the script locally with the same `args` to reproduce a script error.
3. Check that the script doesn't depend on tools a coding run doesn't have:
   Docker, built-in `Bash` or `Edit`, or network access (see
   [what a script can and can't do](../coding-workflows.md#what-a-script-can-and-cannot-do)).

See [Run a Claude Code workflow script](../coding-workflows.md).
