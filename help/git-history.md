---
id: git-history
title: Git history in coding runs (gitHistory, remote links)
summary: Turn on codingProfile.gitHistory so a coding agent gets a real .git, can commit and merge, and its commits (merge commits included) reach the pull request; add upstreams as remote links with as "remote".
audience: operator
tags: [git history, gitHistory, coding-agents, remote link, link_repository, merge, fork sync]
appliesTo: ">=0.9.13"
---

# Git history in coding runs

By default a coding run's `/workspace` holds files only: no `.git`, and the
agent's changes are collected and committed by Wardby as one commit. Set
`codingProfile.gitHistory` and the run gets a real `.git` instead, so the agent
can use `log`, `blame`, `bisect`, `merge` and `commit`. The pull request then
carries the agent's real commits, merge commits included.

## Turn it on

```json
{ "codingProfile": { "gitHistory": { "depth": "full" } } }
```

- `depth` is a whole number from 1 to 100000, or `"full"`. `null` (the
  default) is off, with today's behaviour. `update_agent` with
  `gitHistory: null` turns it off again.
- A numeric depth can give somewhat more history than asked, never less. Use
  `"full"` for a [fork sync](fork-sync.md) so the merge base is always found.
- It applies to every **writable** repository of the run: `/workspace` and each
  writable `/repos/<name>`. Read-only folders never get a `.git`.
- `get_agent` shows the stored value as `gitHistoryDepth` (a number or null) and
  `gitHistoryFull` (true or false); `create_agent` and `update_agent` take
  the single `gitHistory` object. `full` overrides depth.
- Codex runs need a worker image on `driver-v31` or later with `git` in it; a
  Claude Code tool runner needs `git` too. The standard images have it. See
  [Build a custom worker image](build-worker-image.md) for your own.

## Remote links: an upstream as a git remote

A read link with `as: "remote"` is fetched into the default repository's `.git`
instead of being mounted as a folder:

```json
{
  "agentId": "<agent id>",
  "repository": "upstream-org/upstream",
  "access": "read",
  "name": "upstream",
  "ref": "main",
  "inDefaultSet": true,
  "as": "remote"
}
```

- `name` becomes the git remote name; `origin` is reserved.
- The resolved commit appears as `refs/remotes/<name>/<label>`. The label is
  the branch or tag name you gave as `ref`; for a 40-hex SHA or a `fromFile`
  ref it is `pinned`. So the example gives `upstream/main`.
- Only a read link on a coding agent can be a remote, and it must be on the
  same host as the default repository (GitHub with GitHub, `local:` with
  `local:`). Otherwise `link_repository` or the run is refused with
  [`repository_remote_invalid`](errors/repository-remote-invalid.md).
- A run whose set includes a remote link while `gitHistory` is off is refused
  with [`repository_remote_needs_history`](errors/repository-remote-needs-history.md).
  A scheduled run records that as `refused`.
- Remote links count toward `CODING_MAX_RUN_REPOSITORIES` like other extras.
- The fetch happens in Wardby before the run starts. If it fails the run ends
  with [`vcs_remote_fetch_failed`](errors/vcs-remote-fetch-failed.md).

## What the agent sees

The run's task text says the workspace has history to the configured depth (or
full), lists the remotes as `<name>/<label> at <commit>`, and says that
fetching and pushing are not possible, so the agent should commit its work.
Uncommitted changes are collected too and committed on top. The agent cannot
fetch or push: the `.git` has no remotes and no credentials, and `git fetch`
fails.

## What reaches the pull request

- The agent's commits are pushed, with their messages, parents and trees.
  Commit **identity is rewritten** to `Wardby <wardby@users.noreply.github.com>`:
  author and committer dates are kept, signatures are dropped and non-UTF-8
  messages are re-encoded. The commit SHAs differ from the run's own.
- A merge commit's upstream parents are kept, so the next sync's merge base has
  moved forward and only merges what is new.
- If the agent only fast-forwards to a remote's tip, upstream's tip is pushed
  unchanged. Upstream's own commits are not checked against `protectedPaths`
  (they are upstream's); the agent's own commits and merge resolutions are.
- The usual checks run on the agent's changes: the changed-file and diff-size
  limits, `protectedPaths`, and conflict markers in every path the agent's
  merge commits changed, judged on the final tree.
- A continuation (a follow-up) starts from the pull request branch. If the
  target branch needs merging first and it conflicts, the merge is committed
  with the conflict markers in place and the agent must resolve them; the
  final tree is checked.
- Work stopped by the budget (`budget_exhausted`) keeps its commits too.

## Limits

- At most 500 new commits per repository, each message at most 64 KiB.
- The result bundle the worker returns is at most `CODING_MAX_RESULT_BUNDLE_MB`
  (default 256, never more than the run's disk).
- Paths no run ever collects are never published from a commit: dependency and
  cache folders (`node_modules`, `.venv`, `venv`, `__pycache__`,
  `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `.tox`, `.vite`, `.cache`) and
  the agent's `collectExclude`. See
  [`vcs_result_path_excluded`](errors/vcs-result-path-excluded.md).

## Failures

Each has its own article:

- [`repository_remote_invalid`](errors/repository-remote-invalid.md),
  [`repository_remote_needs_history`](errors/repository-remote-needs-history.md)
- [`vcs_remote_fetch_failed`](errors/vcs-remote-fetch-failed.md)
- [`vcs_result_bundle_invalid`](errors/vcs-result-bundle-invalid.md),
  [`vcs_result_bundle_too_large`](errors/vcs-result-bundle-too-large.md)
- [`vcs_result_history_invalid`](errors/vcs-result-history-invalid.md),
  [`vcs_result_commit_limit`](errors/vcs-result-commit-limit.md),
  [`vcs_result_commit_unsafe`](errors/vcs-result-commit-unsafe.md),
  [`vcs_result_path_excluded`](errors/vcs-result-path-excluded.md)
- [`worker_git_unavailable`](errors/worker-git-unavailable.md)

These are rarer internal checks with no article of their own. The first four
fail the run in the `workspace` category; `job_result_bundle_limit_invalid`
is a `preflight` (configuration) failure:

- `vcs_history_shortened`, reported as `vcs_remote_fetch_failed:origin`:
  deepening the target branch for a continuation made the history shorter, which
  can happen with merge-heavy shallow histories. Use `depth: "full"`.
- `vcs_git_history_invalid`: the history setting reaching the VCS layer was not
  a depth from 1 to 100000 or `"full"`. Fix `codingProfile.gitHistory`.
- `vcs_worker_git_invalid`: Wardby could not build the run's `.git` consistently
  (a ref it wrote did not resolve). Retry; if it repeats, report it with the
  server log.
- `kubernetes_result_bundle_read_failed`: on Kubernetes, reading the result
  bundle out of the run's workspace failed. Retry the run.
- `job_result_bundle_limit_invalid`: `CODING_MAX_RESULT_BUNDLE_MB` is not a
  positive whole number. The server normally refuses to start with that value;
  fix the setting.

Related: [Several repositories in one coding run](multi-repository-runs.md),
[Fork sync](fork-sync.md), [Build a custom worker image](build-worker-image.md).
Operator guide:
[`docs/coding-agent-setup.md`](../docs/coding-agent-setup.md#git-history-in-a-run).
