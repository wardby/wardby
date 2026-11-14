---
id: errors/vcs-result-bundle-invalid
title: Result bundle is not valid (vcs_result_bundle_invalid)
summary: The commits a git-history run returned did not arrive as a valid, single-head git bundle, so none of its history was imported.
audience: operator
tags: [error, coding-agents, vcs_result_bundle_invalid, git history, result bundle]
appliesTo: ">=0.9.13"
---

# Result bundle is not valid

A git-history run returns its new commits as a git bundle. Wardby checks it
completely before importing anything. `vcs_result_bundle_invalid` means the
bundle was missing or not a regular file, had a malformed header, did not name
exactly one head, or failed git's object checks. The run fails in the
`workspace` category and nothing is pushed.

It is usually the agent damaging its own `.git` (replacing it, or writing
into the bundle file), or a worker that crashed while writing it. Trigger the
run again; if it repeats, look at what the agent did to `.git` in the run's
steps. Nothing in the run's `.git` can reach Wardby's own repository except
through this check.

See [Git history in coding runs](../git-history.md) and
[`vcs_result_bundle_too_large`](vcs-result-bundle-too-large.md).
