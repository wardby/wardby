---
id: errors/patch-cursor-malformed
title: Patch cursor is malformed
summary: A repo_pr_read call passed a patchCursor that is not a well-formed cursor for the pull request (edited, truncated, retyped or too long).
audience: operator
tags: [error, code-review-agents, repo_pr_read, patchCursor, patch_cursor_malformed, patch_cursor_stale]
appliesTo: ">=0.7.0"
---

# Patch cursor is malformed

`repo_pr_read` returns `patch_cursor_malformed` to a review agent when the
`patchCursor` it passed is not a well-formed cursor for this pull request: the
value was edited, truncated, damaged in transit, retyped by the model, or is
over-long. No page is returned or recorded as read, and nothing else changes;
the call can be made again.

A cursor is also tied to the pull request's head and compare. When the pull
request has moved on since the cursor was issued, the call returns
`patch_cursor_stale` instead.

## What to do

- Pass `nextPatchCursor` back exactly as `repo_pr_read` returned it, with the
  same arguments as the call that produced it.
- After `patch_cursor_stale`, or if no valid cursor is at hand, call
  `repo_pr_read` again without `patchCursor` to start from the first page.
- If a model keeps rewriting the cursor, tell it in the agent's prompt to copy
  `nextPatchCursor` verbatim.

See [Code review agents](../code-review-agents.md) for how patch pages work.
