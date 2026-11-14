---
id: errors/vcs-result-path-excluded
title: Commit touches an excluded path (vcs_result_path_excluded)
summary: A commit in a git-history run changed a path that no run collects, such as node_modules or a collectExclude path, so nothing was pushed.
audience: operator
tags: [error, coding-agents, vcs_result_path_excluded, git history, collectExclude, node_modules]
appliesTo: ">=0.9.13"
---

# Commit touches an excluded path

Some paths are never sent back from a run: dependency and cache folders matched
by name at any depth (`node_modules`, `.venv`, `venv`, `__pycache__`,
`.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `.tox`, `.vite`, `.cache`) and
the agent's `codingProfile.collectExclude` paths. The same rule applies to
commits: if any new commit touches one of these paths, even one that a later
commit deletes, the run fails with `vcs_result_path_excluded` in the `workspace`
category and nothing is pushed. Sandbox tooling writes files there that are not
the agent's work, such as package manager configuration.

Wardby's `.git/info/exclude` in the run keeps `git add -A` away from these
paths, so it usually means the agent forced them in (`git add -f`). Ask it not
to. A repository that really tracks files under one of those names cannot use
git-history runs for commits that touch them.

See [Git history in coding runs](../git-history.md).
