---
id: multi-repository-runs
title: Several repositories in one coding run (read-only and writable)
summary: Give one coding agent a default set of extra repositories, writable or read-only, mounted at /repos/<name>; choose them per run with repositories, and see how pull requests, follow-ups and failures work.
audience: operator
tags: [coding-agents, multiple repositories, read-only repository, link_repository, repositories, inDefaultSet]
appliesTo: ">=0.9.13"
---

# Several repositories in one coding run

A coding run always has its **default repository** at `/workspace`
(`codingProfile.repository`). It can also hold more repositories, each in its
own folder, `/repos/<name>`:

- a **writable** extra: a write link without triggers. Changes are collected,
  pushed to their own branch and published as their own pull request.
- a **read-only** extra: a read link. The run gets one commit's files and no
  git history, and nothing in the folder is collected or pushed. With
  `as: "remote"` the link is not a folder at all: its commit is fetched into
  the default repository's git history as a remote of that name (needs
  `codingProfile.gitHistory`); see [Git history in coding runs](git-history.md).

## Set it up

1. Link each extra with `link_repository`. A read link takes a `ref` (a branch,
   tag or 40-hex commit SHA, or `{ "fromFile": "<path>" }`), no triggers and no
   `baseRef`. Both kinds take an optional `name` (the folder; default the
   repository's short name in lower case) and `inDefaultSet`.
2. Mark the links every run should get with `inDefaultSet: true`. The run's
   repositories are the default repository plus those links.
3. To change the set for one run, pass `repositories` (a list of link names)
   to `trigger_agent`, `wardbyRepositories` in a webhook body, or
   `repositories` in a `delegate_to_<name>` call. It replaces the default set;
   `[]` means the default repository only. From anyone but the agent's owner
   it needs `codingProfile.allowWebhookTaskOverride`, like `repository`.

```json
{
  "agentId": "<agent id>",
  "repository": "upstream-org/upstream",
  "access": "read",
  "name": "upstream",
  "ref": "main",
  "inDefaultSet": true
}
```

## Good to know

- A `ref: { "fromFile": "<path>" }` is read from the default repository's base
  branch when the run is dispatched. See
  [`repository_ref_unreadable`](errors/repository-ref-unreadable.md).
- The refs are resolved to commits at dispatch and recorded, so a moving branch
  does not change a run already started. The run's task text carries one line
  per extra with its folder, repository, full commit and access, for example
  `Extra repository /repos/upstream: upstream-org/upstream at <commit>, read-only.`
- Read links follow the GitHub allowlist like every link: to read another
  account's repository, add that account to `WARDBY_GITHUB_ALLOWED_ACCOUNTS`.
  The agent's owner needs read access to a private repository.
- `CODING_MAX_RUN_REPOSITORIES` (default 5, from 1 to 17) caps the default
  repository plus its extras. See
  [`repository_set_too_large`](errors/repository-set-too-large.md).
- All repositories share the agent's toolchain, budget, prompt, protected paths
  and package allowlist, and the run's disk and 100,000-entry limits. Only the
  default repository supplies `CLAUDE.md`, skills, services and the dependency
  cache.
- A Codex agent with its own `workerImageRef` needs that image rebuilt on
  `driver-v30` or later before its runs get extras; an older driver rejects the
  run input (`worker_input_failed`). Runs with only the default repository are
  not affected.
- With `codingProfile.gitHistory` on, every writable repository (`/workspace`
  and writable `/repos/<name>`) gets its own `.git`, and the task line for a
  writable extra reads `writable, with git history`. Remote links need history
  and the same host as the default repository:
  [`repository_remote_invalid`](errors/repository-remote-invalid.md),
  [`repository_remote_needs_history`](errors/repository-remote-needs-history.md).
  History needs `driver-v31` or later on a Codex `workerImageRef`.
- Being in a set starts no review, mention follow-up, fix round or mark-ready
  in a repository; link the lead and reviewer there with the triggers you want.

## Pull requests and failures

Each writable repository with changes gets its own pull request, the default
repository first. They list each other under "Related pull requests". If some
published and others failed, the run is `failed` with `partially_published`
and what published stays published; see
[`partially_published`](errors/partially-published.md). A top-level run's own
pull requests are in `run_completed.pullRequests` and the finished comment.

## Follow-ups

A follow-up, review fix round or mark-ready works in the set of the run it
continues, with the same names and commits. A follow-up can start from the pull
request of any writable repository of the set. Only one follow-up runs at a
time for each run, single-repository runs included: a mention meanwhile gets a
reply that one is already running, so mention again after it finishes.
Sending `repositories` with a continuation is refused with
`invalid_repositories`.

Resuming a Claude Code run locally maps only `/workspace`; the other
repositories are not recreated on your machine.

## Failures

Name, set and ref refusals happen at dispatch, before a run exists. A scheduled
run has no caller to answer, so its set or ref refusal is recorded as a
`refused` run with the same message, and the schedule moves on to its next
time.

- [`repository_name_taken`](errors/repository-name-taken.md) and
  [`repository_name_invalid`](errors/repository-name-invalid.md) at link time.
- [`repository_not_listed`](errors/repository-not-listed.md),
  [`invalid_repositories`](errors/invalid-repositories.md),
  [`repository_set_too_large`](errors/repository-set-too-large.md) and
  [`repository_ref_unreadable`](errors/repository-ref-unreadable.md) for a
  run's list. A delegating lead receives them as `{ "error", "message" }`.
- `repo_access_*`: the owner's access to one of the set's repositories is
  missing or could not be checked; see
  [Repository access refused](errors/repo-access.md).
- [`coding_repositories_unsupported`](errors/coding-repositories-unsupported.md),
  [`coding_repository_unresolved`](errors/coding-repository-unresolved.md) and
  [`vcs_read_only_fetch_failed`](errors/vcs-read-only-fetch-failed.md) when
  the deployment or a row cannot supply an extra.

Some guards report only as the failure category `coding_failure_workspace` on
the run, with the code in the server log. They are internal checks that a
malformed row or an unsupported host would trip: `vcs_slot_invalid`,
`vcs_branch_run_id_invalid`, `vcs_read_only_input_invalid` (a name, run id or
commit that does not look the way link validation guarantees),
`vcs_read_only_unsupported` (the repository's host cannot make read-only
copies) and `vcs_workspace_entry_limit` (all the run's repositories together
hold more than 100,000 files and folders; drop a repository from the run or
shrink it).

Related: [Git history in coding runs](git-history.md), [Fork sync](fork-sync.md), [Agent
recipes](agent-recipes.md), [Local repositories](local-repositories.md) and
[Related pull requests](related-pull-requests.md). Operator guide:
[`docs/coding-agent-setup.md`](../docs/coding-agent-setup.md#several-repositories-in-one-run).
