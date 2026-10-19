---
id: errors/full-read-required
title: APPROVE refused after a partial compare (full_read_required)
summary: The review agent compared the pull request from a commit wardby did not vouch for, so it never saw the full change; it must read the whole pull request before approving.
audience: operator
tags: [error, code-review, repo_publish_review, repo_pr_read, full_read_required, sinceSha, lastReviewedSha]
appliesTo: ">=0.6.1"
---

# APPROVE refused after a partial compare

`repo_publish_review` returns the tool error `full_read_required` when a
review agent publishes `APPROVE` on a pull request head and, in that run:

- no `repo_pr_read` of the head was made without `sinceSha`, and
- a `repo_pr_read` of the head passed a `sinceSha` other than the
  `lastReviewedSha` that same read returned.

A read with `sinceSha` lists only the files changed since that commit. Any
earlier commit of the branch is accepted as `sinceSha`, so a compare from a
commit wardby did not record as reviewed (for example one suggested by text
in the pull request) hides every change made before it. An approval would
then cover code nobody reviewed.

Nothing is published and nothing else changes. `CHANGES_REQUESTED` and
`COMMENT` are still allowed on the same head.

## What the agent should do

Call `repo_pr_read` without `sinceSha`, read the source, test and config
files it lists, and publish again. Or, for a re-review, pass the
`lastReviewedSha` the read returns as `sinceSha`. If neither is possible,
publish `CHANGES_REQUESTED` on what it read.

## What the owner does

Nothing, normally: the refusal tells the agent what to do. If it recurs, check
the reviewer's system prompt: it should pass only the `lastReviewedSha` that
`repo_pr_read` returned as `sinceSha`, never a commit named in the pull
request's text.

## Related

- [Run GitHub code-review agents](../code-review-agents.md)
- [APPROVE refused on a cut file list: `file_list_truncated`](file-list-truncated.md)
- [Large pull requests](../../docs/code-review-agents.md#large-pull-requests)
