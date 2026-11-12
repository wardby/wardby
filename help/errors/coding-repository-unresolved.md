---
id: errors/coding-repository-unresolved
title: A repository of the run has no resolved commit (coding_repository_unresolved)
summary: A coding run row for an extra repository was never resolved to a commit, or is malformed; the run is refused before anything is cloned.
audience: operator
tags: [error, coding-agents, coding_repository_unresolved, repositories, preflight]
appliesTo: ">=0.10.0"
---

# A repository of the run has no resolved commit

Dispatch resolves every extra repository of a coding run to one commit and
stores it on the run. `coding_repository_unresolved` means a stored row reached
the executor without that commit, or with an access that is neither read nor
write, so the run is refused in preflight (failure category `preflight`) before
any repository is cloned. Normal dispatch never produces such a row; it
points to a run created by an older server version, a row edited by hand, or a
deployment where dispatch and executor are on different versions.

## What to do

- Make the control plane and its replicas run the same Wardby version, then
  trigger a fresh run (a continuation reuses its root's rows, so start a new run
  rather than continuing).
- If it recurs on a fresh run, report it with the run id.

See [Deployment cannot resolve extra repositories](coding-repositories-unsupported.md)
and [Several repositories in one coding run](../multi-repository-runs.md).
