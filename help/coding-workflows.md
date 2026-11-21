---
id: coding-workflows
title: Run a Claude Code workflow script in a coding run
summary: Point a Claude Code coding agent at a .claude/workflows/<name>.js script, from its own repository or a linked one, and pass the script's args with trigger_agent workflowArgs.
audience: operator
tags:
  [
    workflow,
    workflows,
    .claude/workflows,
    workflow script,
    workflowArgs,
    codingProfile.workflow,
    claude-code,
    coding agents,
    sub-agents,
    phases,
  ]
appliesTo: ">=0.10.2"
---

# Run a Claude Code workflow script in a coding run

A Claude Code workflow script (`.claude/workflows/<name>.js`) runs a fixed
process in phases, with a sub-agent for each step. A Claude Code coding agent
can run one: the run uses Claude Code's own `Workflow` tool inside the
worker, in the same sandbox as any other coding run.

Claude Code only. A Codex agent can't run a workflow.

## Set it up

1. Turn on git history for the agent: a workflow run needs it.
2. Name the workflow on the agent:

   ```json
   update_agent { "id": "<agent>", "codingProfile": {
     "workflow": { "name": "fix-bug" },
     "gitHistory": { "depth": 1 } } }
   ```

   `name` is the file `.claude/workflows/<name>.js` (letters, digits, `_` and
   `-`). Add `"repository": "<link name>"` to read the script from a linked
   repository instead of the default one: one reviewed copy of a process can
   then serve many repositories, while each repository's own `CLAUDE.md` and
   skills still supply the specifics.

3. Trigger the agent. `trigger_agent { "agentId": "<agent>", "task": "...",
"workflowArgs": { ... } }` passes `workflowArgs` (a JSON object, at most
   16 KiB) to the script as `args`. Without `workflowArgs`, `args` is the
   task text, as a string.

## What a run does

- The script is read from the run's checkout at the commit resolved for the
  run, with the same rules as other context files: a regular file, not a
  symlink, valid UTF-8, at most 64 KiB. A missing or unreadable script fails
  the run before any model call with
  [`coding_failure_workflow_unavailable`](errors/coding-workflow-unavailable.md).
- Only that one script is loaded. Other workflow files, settings, hooks,
  agents and commands under `.claude/` are never loaded.
- The run calls the workflow once. Wardby fills in `args`. A second call,
  another workflow, an inline script, a script path or a remote run is
  refused.
- The run's result is the session's answer after the workflow finishes. If
  the workflow fails, is stopped or never starts, the run fails with
  [`coding_failure_workflow_failed`](errors/coding-workflow-failed.md).
- When the workflow's result has string `prTitle` and `prBody` fields, the
  pull request uses them.

## What a script can and cannot do

Every sub-agent works in the same sandbox as any coding run:

- Its tools are Wardby's `run_command` (every read, edit and command goes
  through it) and any MCP tools attached to the agent. Claude Code's
  built-in `Bash`, `Read`, `Edit`, `Write` and `WebFetch` are not available.
- There's no Docker and no network beyond what a coding run already allows.
  Steps that run tests with `docker compose` need a direct path: run the
  commands in the run's worker image (see [custom worker images](build-claude-code-image.md)),
  with backing services from [`.wardby/services.yaml`](coding-services.md).
- Leave git and the pull request to Wardby. Local commits are kept on
  Wardby's branch (git history is on), but skip creating branches, pushing
  and opening pull requests.
- A workflow run can't change anything under `.claude/`: Wardby adds
  `.claude/**` to its protected paths.

## Budget

Every sub-agent's model calls go through the coding proxy and count toward
the run's budget; running out stops the whole run. Each request reserves up
to its output limit before it starts, and sub-agents running in `parallel()`
reserve at the same time, so give a workflow agent headroom above what one
request costs, or lower the agent's `maxOutputTokens`.

## See also

- [Repository instructions and skills](repo-instructions-and-skills.md)
- [Multi-repository runs](multi-repository-runs.md)
- Errors: [`coding_failure_workflow_unavailable`](errors/coding-workflow-unavailable.md),
  [`coding_failure_workflow_failed`](errors/coding-workflow-failed.md)
