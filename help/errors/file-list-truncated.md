---
id: errors/file-list-truncated
title: APPROVE refused on a cut file list (file_list_truncated)
summary: The pull request has more changed files than repo_pr_read lists, so a review agent cannot approve it; it can still request changes or comment.
audience: operator
tags: [error, code-review, repo_publish_review, repo_pr_read, file_list_truncated, fileListComplete, large-pull-request]
appliesTo: ">=0.6.1"
---

# APPROVE refused on a cut file list

`repo_publish_review` returns the tool error `file_list_truncated` when a
review agent publishes `APPROVE` on a pull request head after a
`repo_pr_read` of that head in the run reported `fileListComplete: false`,
and no complete read of the whole pull request (without `sinceSha`) has
followed. The host lists at most
1,000 changed files of a pull request (a GitHub compare, used when the agent
passes `sinceSha`, lists at most 300). Files past that cut never reach the
agent, so an approval would cover code nobody reviewed.

Nothing is published and nothing else changes. `CHANGES_REQUESTED` and
`COMMENT` are still allowed on the same head.

## What the agent should do

- If it passed `sinceSha`, call `repo_pr_read` again without it. When the
  whole pull request fits in the list, `fileListComplete` becomes `true` and
  `APPROVE` is allowed again (once every listed source, test or config file
  is read; see `unread_files`). A complete `sinceSha` read does not lift the
  refusal.
- Otherwise publish `CHANGES_REQUESTED` on what it read, and say the pull
  request is too large to review in full. `COMMENT` completes the check as
  neutral, which branch protection treats as passing.

## What the owner does

Split the change into smaller pull requests, each under the limit, or have
a person review it. The limit is the same for GitHub and local repositories.

## Related

- [Run GitHub code-review agents](../code-review-agents.md)
- [Large pull requests](../../docs/code-review-agents.md#large-pull-requests)
