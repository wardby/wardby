---
id: errors/coding-repositories-unsupported
title: This deployment cannot resolve extra repositories (coding_repositories_unsupported)
summary: A coding run asked for extra repositories on an executor that cannot read files or resolve refs in other repositories; no run was started.
audience: operator
tags: [error, coding-agents, coding_repositories_unsupported, repositories, executor]
appliesTo: ">=0.10.0"
---

# This deployment cannot resolve extra repositories

`coding_repositories_unsupported` means the run's set holds extra repositories
(a default set, or a `repositories` list) but this deployment's executor cannot
check access to another repository, read a file in it, or resolve its ref.
Dispatch needs all three to authorize each extra and pin it to a commit. It is
raised at dispatch and no run is started. Runs with only the default repository
are not affected.

It points to an executor that does not implement multiple repositories, such as
a custom or older one behind the executor seam.

Callers see it like the other repository-set refusals:

- `trigger_agent` returns a 400 error with the message
  `coding_repositories_unsupported: this deployment cannot resolve extra repositories.`
- A webhook gets a 400 `{ "error": "invalid_repositories" }` with
  `"error_description": "coding_repositories_unsupported"`.
- A lead's `delegate_to_<name>` call receives
  `{ "error": "coding_repositories_unsupported", "message": … }`.
- A scheduled run, which has no caller to answer, is recorded as `refused`
  with this message in `list_runs`, and the schedule moves on to its next time.

## What to do

- Run the control plane with an executor from Wardby 0.10.0 or later (the
  built-in container executor supports extra repositories).
- Or run the agent with only its default repository: `repositories: []` on
  `trigger_agent`, and no links in the default set.

See [A repository of the run has no resolved commit](coding-repository-unresolved.md)
and [Several repositories in one coding run](../multi-repository-runs.md).
