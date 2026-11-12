---
id: errors/repository-set-too-large
title: Too many repositories for one run (repository_set_too_large)
summary: The default set or a per-run repositories list would put more repositories in one coding run than CODING_MAX_RUN_REPOSITORIES allows.
audience: operator
tags: [error, coding-agents, repository_set_too_large, CODING_MAX_RUN_REPOSITORIES, repositories, inDefaultSet]
appliesTo: ">=0.10.0"
---

# Too many repositories for one run

`repository_set_too_large` means a coding run would have more repositories than
`CODING_MAX_RUN_REPOSITORIES` (default 5). The count includes the default
repository, which is at `/workspace`, plus every extra at `/repos/<name>`.

It is raised in two places, and no run is started (except a scheduled run, see
below):

- `link_repository` with `inDefaultSet: true`, when the default set would
  exceed the limit;
- dispatch, for a `repositories` list given to `trigger_agent`, a webhook
  (`wardbyRepositories`, as a 400 `invalid_repositories` with
  `error_description: repository_set_too_large`) or a delegation, or for a
  default set that grew past a lowered limit.

A write link to the default repository itself does not count as an extra.

A scheduled run has no caller to answer, so the refusal is recorded instead:
the run shows in `list_runs` as `refused` with this message, and the schedule
moves on to its next time.

## What to do

- Remove links from the default set (`link_repository` again without
  `inDefaultSet`, or `unlink_repository`) or send a shorter `repositories` list.
- Or ask the operator to raise `CODING_MAX_RUN_REPOSITORIES`. It must be from 1
  to 17 (the default repository plus 16 extras); a larger value stops start-up.
  The limit does not raise the run's disk budget or its 100,000-entry cap,
  which all repositories share.

See [Several repositories in one coding run](../multi-repository-runs.md).
