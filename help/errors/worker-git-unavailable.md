---
id: errors/worker-git-unavailable
title: Git missing in the worker image (worker_git_unavailable)
summary: A git-history run needs git in the worker, and a custom Codex worker image or Claude Code tool runner image does not have it.
audience: operator
tags: [error, worker_git_unavailable, job_worker_git_unavailable, git history, driver-v31]
appliesTo: ">=0.9.13"
---

# Git missing in the worker image

A git-history run checks at start that git runs where the agent works. If it
does not, the run fails with `worker_git_unavailable` (seen as
`job_worker_git_unavailable` on the job) in the `preflight` category: it is an
image configuration problem, not a transient failure.

The standard images include git. This appears with an agent's own
`workerImageRef`:

- **Codex:** build the image `FROM` a current `driver-vN` digest (`driver-v31`
  or later for history) and keep `git` installed.
- **Claude Code:** build the tool runner `FROM` the release's
  `wardby-claude-tool-runner` image and keep `git`.

Rebuild, set the new `workerImageRef` with `update_agent`, or clear it to use
the standard image, or turn `gitHistory` off. See
[Build a custom worker image](../build-worker-image.md),
[Build a tool runner image for a Claude Code agent](../build-claude-code-image.md)
and [Git history in coding runs](../git-history.md).
