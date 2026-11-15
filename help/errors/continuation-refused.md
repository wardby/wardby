---
id: errors/continuation-refused
title: Continuation refused (continuePriorRun)
summary: A continuePriorRun request named a run that cannot be continued; the message's leading code says why, and no run was started.
audience: operator
tags: [error, continuePriorRun, continuation_refused, unknown_run, other_agent_run, not_a_coding_run, run_not_finished]
appliesTo: ">=0.9.15"
---

# Continuation refused

A request to continue an earlier coding run (`trigger_agent`'s
`continuePriorRun`, or a lead's `delegate_to_<name>` call with
`continuePriorRun`) was refused. No run was started and nothing was spent.
`trigger_agent` returns an error whose message begins with one of the codes
below; a lead's call gets `{ "error": "continuation_refused", "message" }`.
Messages are fixed text and never repeat the run id or repository you sent.

| Code               | Meaning                                                                                                                                                              | What to do                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `unknown_run`      | This deployment has no such run, or the run belongs to an agent you cannot see.                                                                                      | Check the id with `list_runs` or `get_run`.                                                     |
| `other_agent_run`  | The run belongs to a different agent than the one triggered (`trigger_agent` only).                                                                                  | Trigger the agent that made the run, or delegate from a lead, which may continue across agents. |
| `not_a_coding_run` | The run ended before its coding run was created (for example, it was refused at dispatch), so there is no branch to continue (`trigger_agent` only).                 | Start a new run without `continuePriorRun`.                                                     |
| `run_not_finished` | The run is still pending or running. Only `trigger_agent` and delegation continuations are refused this way; review-fix rounds and mentions wait or decline instead. | Wait until `get_run` shows it ended, then ask again.                                            |
| `other_repository` | The `repository` you sent is not the repository of the run being continued, or the run was in a repository this agent does not work in.                              | Leave `repository` out: a continuation works in the first run's repository.                     |
| `no_pull_request`  | The first run in a hosted repository (GitHub, Bitbucket) never opened a pull request (it made no changes, or its publish failed), so there is no branch to continue. | Start a new run without `continuePriorRun`.                                                     |
| `no_pushed_branch` | The first run in a local repository never pushed its branch.                                                                                                         | See [No pushed branch to continue](no-pushed-branch.md).                                        |
| `other_owner`      | The first run was made by an agent with a different owner.                                                                                                           | Continue it from an agent of that owner, or start a new run.                                    |

Two related refusals are not continuation codes: a caller who is not the
agent's owner gets a 403 (`continuePriorRun is only allowed when the sub-agent
has the same owner.`), and a non-coding agent gets
`continuation_requires_coding_agent`. Sending `baseRef` with `continuePriorRun`
is refused as an invalid argument, and sending `repositories` with it as
[`invalid_repositories`](invalid-repositories.md).

See [Continue a coding run](../continue-coding-run.md). A continuation that
was accepted but whose pull request was merged or closed in the meantime stops
with [`continuation_closed`](continuation-closed.md).
