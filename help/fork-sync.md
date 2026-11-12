---
id: fork-sync
title: Keep a fork in sync with its upstream (fork sync)
summary: A scheduled coding agent three-way merges what changed upstream into a fork using two read-only copies of the upstream, a marker file and one pull request.
audience: operator
tags: [fork sync, upstream, coding-agents, recipe, multiple repositories, read-only repository, upstream-sync]
appliesTo: ">=0.10.0"
---

# Keep a fork in sync with its upstream

A fork sync run holds three copies of code with no git history:

| Folder            | Repository                           | Access    |
| ----------------- | ------------------------------------ | --------- |
| `/workspace`      | `your-org/your-fork`, base branch    | writable  |
| `/repos/base`     | `upstream-org/upstream`, last synced | read-only |
| `/repos/upstream` | `upstream-org/upstream`, `main`      | read-only |

## Set it up

1. Create a coding agent whose `codingProfile.repository` is
   `your-org/your-fork` and give it a `defaultTask`.
2. Keep a one-line `upstream-sync` file at the root of the fork's base branch
   holding the upstream commit last synced: a full 40-hex commit SHA (or a
   release tag that never moves), never a branch.
3. Link the upstream twice, both read-only and in the default set:

   ```json
   {
     "agentId": "<agent id>",
     "repository": "upstream-org/upstream",
     "access": "read",
     "name": "base",
     "ref": { "fromFile": "upstream-sync" },
     "inDefaultSet": true
   }
   ```

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

4. In the task, ask the agent to find the files that differ between
   `/repos/base` and `/repos/upstream`, merge each three ways into the fork's
   file, resolve conflicts without leaving markers, write `upstream`'s full
   commit SHA into `upstream-sync`, and run the tests. The run's task text carries
   one line per extra repository giving its full commit
   (`Extra repository /repos/upstream: upstream-org/upstream at <commit>, read-only.`),
   so the agent copies the value from there. Never let it write a branch such
   as `main`: the next run would read `base` at the same commit as `upstream`,
   see nothing to merge, and the fork would silently stop syncing.
5. Schedule the agent with `set_schedule`.

## The merge command

- **Codex** has git: `git merge-file <fork file> <base file> <upstream file>`
  merges into the fork file and exits non-zero while conflicts remain.
- **Claude Code**'s tool runner has no git. Run
  `diff3 -m -E <fork file> <base file> <upstream file>`, which prints the merge
  to standard output (redirect it into the fork file) and exits 1 when it wrote
  conflict markers.

Name the right one in the task for the agent's provider.

## When it fails

- `repository_ref_unreadable`: the `upstream-sync` file is missing, empty,
  longer than 255 bytes, or not a ref, or the ref does not exist upstream. Fix
  the file. See [the error](errors/repository-ref-unreadable.md).
- `repo_access_*`: the owner cannot read the upstream. A public upstream of
  another account also needs that account in `WARDBY_GITHUB_ALLOWED_ACCOUNTS`.
- `partially_published`: see [that error](errors/partially-published.md).

Related: [Several repositories in one coding run](multi-repository-runs.md),
[Agent recipes](agent-recipes.md). Operator guide:
[`docs/agent-recipes.md`](../docs/agent-recipes.md#fork-sync-one-coding-agent-three-repositories).
