---
id: errors/vcs-result-bundle-too-large
title: Result bundle too large (vcs_result_bundle_too_large)
summary: A git-history run's returned commits are bigger than CODING_MAX_RESULT_BUNDLE_MB.
audience: operator
tags: [error, coding-agents, vcs_result_bundle_too_large, CODING_MAX_RESULT_BUNDLE_MB, git history, result bundle]
appliesTo: ">=0.9.13"
---

# Result bundle too large

The commits a git-history run made come back as a bundle of at most
`CODING_MAX_RESULT_BUNDLE_MB` megabytes (default 256, and never more than the
run's disk). A larger one fails the run with `vcs_result_bundle_too_large` in
the `workspace` category, and nothing is pushed.

- Ask the agent to commit less: large generated or binary files, or a merge
  that pulls in a long history of new objects, are the usual cause.
- Or raise `CODING_MAX_RESULT_BUNDLE_MB` on the server (a positive whole
  number; the effective limit stays within the run's disk, so raise
  `workspaceDiskMb` as well if needed).

See [Git history in coding runs](../git-history.md).
