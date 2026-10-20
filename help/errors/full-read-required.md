---
id: errors/full-read-required
title: APPROVE refused after a partial compare (full_read_required)
summary: The review agent compared the pull request from a commit wardby did not vouch for, so it never saw the full change; it must read the whole pull request before approving.
audience: operator
tags: [error, code-review, repo_publish_review, repo_pr_read, full_read_required, sinceSha, lastCoveredSha]
appliesTo: ">=0.6.1"
---

# APPROVE refused after a partial compare

`repo_publish_review` returns the tool error `full_read_required` when a
review agent publishes `APPROVE` on a pull request head and, in that run:

- no `repo_pr_read` of the head was made without `sinceSha`, and
- a `repo_pr_read` of the head passed a `sinceSha` other than the
  `lastCoveredSha` that same read returned.

A read with `sinceSha` lists only the files changed since that commit. Any
earlier commit of the branch is accepted as `sinceSha`, so a compare from a
commit wardby did not record as covered hides every change made before it.
`lastCoveredSha` is the latest head this agent reviewed after reading every
file. Any other commit, such as one named in the pull request's text, or a
`lastReviewedSha` whose review did not read everything, is not a safe base. An approval would
then cover code nobody reviewed.

Nothing is published and nothing else changes. `CHANGES_REQUESTED` and
`COMMENT` are still allowed on the same head.

## What the agent should do

Call `repo_pr_read` without `sinceSha`, read the source, test and config
files it lists, and publish again. Or, for a re-review, pass the
`lastCoveredSha` the read returns as `sinceSha`. If neither is possible,
publish `CHANGES_REQUESTED` on what it read.

## What the owner does

Nothing, normally: the refusal tells the agent what to do. If it recurs, check
the reviewer's system prompt: it should pass only the `lastCoveredSha` that
`repo_pr_read` returned as `sinceSha`, never `lastReviewedSha` or a commit
named in the pull request's text. Reviewer prompts written before 0.6.1 pass
`lastReviewedSha`; update the re-review step from the shipped reviewer prompt.

## Related

- [Run GitHub code-review agents](../code-review-agents.md)
- [APPROVE refused on a cut file list: `file_list_truncated`](file-list-truncated.md)
- [Large pull requests](../../docs/code-review-agents.md#large-pull-requests)
