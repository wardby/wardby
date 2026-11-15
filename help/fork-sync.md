---
id: fork-sync
title: Keep a fork in sync with its upstream (fork sync)
summary: A scheduled coding agent merges upstream into a fork with git merge (git history and a remote link), or, without history, three-way merges using two read-only copies of the upstream, a marker file and one pull request.
audience: operator
tags: [fork sync, upstream, coding-agents, recipe, upstream-sync, git history, remote link]
appliesTo: ">=0.9.13"
---

# Keep a fork in sync with its upstream

## Recommended: git history and a remote link

With git history on, a sync is the merge you would do by hand, and its merge
commit moves the merge base forward, so the next run only merges what is new.

1. Create a coding agent whose `codingProfile.repository` is
   `your-org/your-fork`, with a `defaultTask` and
   `gitHistory: { "depth": "full" }` (`full` so the merge base is always found).
2. Link the upstream as a read-only **remote**, in the default set. The name
   `upstream` becomes the git remote:

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

3. In the task, ask the agent to run `git merge upstream/main`, fix every
   conflict (never leaving markers), run the tests, and commit. The run's task
   text lists the remote as `upstream/main at <commit>`. There is no
   `upstream-sync` marker file: the merge commit records what was synced.
4. Schedule the agent with `set_schedule`.

The pull request carries the agent's merge commit with upstream's commits as its
parents. The commit author is rewritten to Wardby; see
[Git history in coding runs](git-history.md) for what is checked and the
limits. Codex and Claude Code both have git in their standard images; a custom
`workerImageRef` image needs `git` and, for Codex, `driver-v31` or later.

## Without git history: three folders

Use this variant when git is not available in the agent's image, or you prefer not to turn history on. The run holds three copies of code with no git history:

| Folder            | Repository                           | Access    |
| ----------------- | ------------------------------------ | --------- |
| `/workspace`      | `your-org/your-fork`, base branch    | writable  |
| `/repos/base`     | `upstream-org/upstream`, last synced | read-only |
| `/repos/upstream` | `upstream-org/upstream`, `main`      | read-only |

### Set it up

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

### The merge command

- **Codex** has git: `git merge-file <fork file> <base file> <upstream file>`
  merges into the fork file and exits non-zero while conflicts remain.
- **Claude Code**'s tool runner also has git. `git merge-file` works the same;
  `diff3 -m -E <fork file> <base file> <upstream file>` is an alternative that
  prints the merge to standard output (redirect it into the fork file) and
  exits 1 when it wrote conflict markers.

Name the one you want in the task.

## When it fails

- `repository_ref_unreadable`: the `upstream-sync` file is missing, empty,
  longer than 255 bytes, or not a ref, or the ref does not exist upstream. Fix
  the file. See [the error](errors/repository-ref-unreadable.md).
- `repo_access_*`: the owner cannot read the upstream. A public upstream of
  another account also needs that account in `WARDBY_GITHUB_ALLOWED_ACCOUNTS`.
- `partially_published`: see [that error](errors/partially-published.md).

Related: [Git history in coding runs](git-history.md), [Several repositories in one coding run](multi-repository-runs.md),
[Agent recipes](agent-recipes.md). Operator guide:
[`docs/agent-recipes.md`](../docs/agent-recipes.md#fork-sync-one-coding-agent-git-history-and-a-remote).
