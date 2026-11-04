---
id: errors/repository-required
title: Repository required (repository_required)
summary: A coding agent with several repositories was asked to work without being told which one; pass repository, or use continuePriorRun.
audience: operator
tags: [error, coding-agents, repository_required, repository, link_repository, delegation]
appliesTo: ">=0.8.0"
---

# Repository required

`repository_required` means a coding agent has more than its default repository
(it has write links without triggers added with `link_repository`), and the
request did not say which one to work in. Nothing was started.

A `delegate_to_<name>` call to such a sub-agent must name a repository. The
exception is a follow-up: with `continuePriorRun`, the run works in the
repository of the run it continues. The message lists the repositories on the
agent's list.

## What to do

- Pass `repository` on the call, using one of the listed repositories, for
  example `your-org/your-repo`.
- Tell the lead agent in its system prompt which repository each kind of
  change belongs to.
- If the agent should only work in one repository, remove the extra ones with
  `unlink_repository`.

On `trigger_agent` and webhooks, leaving `repository` out uses the default
repository (`codingProfile.repository`) and is not an error. Webhooks use the
body field `wardbyRepository`.

See [Repository not on the agent's list](repository-not-listed.md),
[Agent recipes](../agent-recipes.md) and the operator guide
`docs/coding-agent-setup.md`, section "A coding agent's repositories".
