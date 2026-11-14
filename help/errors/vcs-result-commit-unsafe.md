---
id: errors/vcs-result-commit-unsafe
title: Commit text refused (vcs_result_commit_unsafe)
summary: A commit message or author or committer name or email from a git-history run looks like it holds a secret, or is longer than 64 KiB, so nothing was pushed.
audience: operator
tags: [error, coding-agents, vcs_result_commit_unsafe, git history, secrets, commit message]
appliesTo: ">=0.9.13"
---

# Commit text refused

Commit text is published to the host, so Wardby checks every new commit before
pushing it. `vcs_result_commit_unsafe` means a commit message, or an author or
committer name or email, matched the shape of a token or credential, or a
message was longer than 64 KiB. The run fails in the `workspace` category and
nothing is pushed. The message does not repeat the text.

Ask the agent to rewrite the offending commit message without the token-like
value (and not to paste secrets or command output into messages), then
trigger again. A real credential that reached a message should be rotated.

See [Git history in coding runs](../git-history.md).
