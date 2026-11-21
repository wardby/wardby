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
    replyField,
    args.wardby,
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
   16 KiB) to the script as `args`. A lead agent passes it the same way:
   `delegate_to_<name>` takes `workflowArgs` when the sub-agent has a
   workflow. Without `workflowArgs`, `args` is the request text as a string:
   the task alone, without the agent's standing instructions.

## Tell a Wardby run from a laptop run

A script can't read environment variables or files, so it can't detect
Wardby by itself. When `args` is an object, Wardby adds a reserved `wardby`
field, `{ "runId": "...", "baseSha": "..." }`: the run's id and the commit
the checkout starts at. A script can branch on it:

```js
const ON_WARDBY = Boolean(args && args.wardby);
```

Any `wardby` key you pass in `workflowArgs` is replaced. A run whose `args`
is a string gets no marker, so pass an object when the script needs one.

## Post the script text word for word

By default the run's reply is the session's summary of what the workflow
returned. To use one of the script's fields word for word instead, name it:

```json
{ "workflow": { "name": "triage", "replyField": "comment" } }
```

- A run with no pull request uses that string field as its reply. When a
  lead agent delegated the run and posts to an issue (GitHub or Jira), the
  issue gets that text in place of the lead's own reply, as long as exactly
  one such sub-run finished.
- A run with a pull request uses the result's string `prTitle` and `prBody`
  as the commit title and pull request description, word for word, with the
  usual limits.
- A missing or non-string field, or a result Wardby can't read, keeps the
  session's summary.

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
- Once the workflow has completed, the run keeps its result even when the
  session can't give a valid final answer: Wardby builds it from the
  script's returned value (`replyField`, `prTitle` and `prBody`), and
  collection decides from the workspace whether anything changed.
- The run's result is the session's answer after the workflow finishes. If
  the workflow fails, is stopped or never starts, the run fails with
  [`coding_failure_workflow_failed`](errors/coding-workflow-failed.md).
- The run's steps are grouped by the script's phases and sub-agents
  (`get_run_steps` returns `workflow` and each sub-agent step's `agent`); see
  [run steps](run-steps.md#workflow-runs).
- When the workflow's result has string `prTitle` and `prBody` fields, the
  pull request uses them (see [the script's text word for word](#post-the-script-text-word-for-word)).

## What a script can and cannot do

Every sub-agent works in the same sandbox as any coding run:

- Its tools are Wardby's `run_command` (every read, edit and command goes
  through it) and any MCP tools attached to the agent. Claude Code's
  built-in `Bash`, `Read`, `Edit`, `Write` and `WebFetch` are not available.
- There's no Docker and no network beyond what a coding run already allows.
  Steps that run tests with `docker compose` need a direct path: run the
  commands in the run's worker image (see [custom worker images](build-claude-code-image.md)),
  with backing services from [`.wardby/services.yaml`](coding-services.md).
- Name files by their path in `/workspace` in each sub-agent's prompt (for
  example "Read /workspace/tickets/SIM-1.md"). Sub-agents start in a folder
  that holds only the run's instruction files and otherwise look there first.
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
