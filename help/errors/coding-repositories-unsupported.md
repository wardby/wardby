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
read a file or resolve a ref in a repository, which dispatch needs to pin each
extra to a commit. It is raised at dispatch and no run is started. Runs with
only the default repository are not affected.

It points to an executor that does not implement multiple repositories, such as
a custom or older one behind the executor seam.

## What to do

- Use an executor from Wardby 0.10.0 or later, or run the agent with only its
  default repository (`repositories: []` on `trigger_agent`, and no links in the
  default set).
- Check the server version with the version your workers expect.

See [A repository of the run has no resolved commit](coding-repository-unresolved.md)
and [Several repositories in one coding run](../multi-repository-runs.md).
