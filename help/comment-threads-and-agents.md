---
id: comment-threads-and-agents
title: Send comment threads to a coding agent
summary: Link a document to a repository file and a coding agent, then send open comment threads to it; the agent edits the file, Wardby publishes the next version and replies on each thread.
audience: operator
tags: [documents, comments, send_threads_to_agent, coding agent, comment trigger, repository]
appliesTo: ">=0.10.0"
---

# Send comment threads to a coding agent

A document can be linked, at creation, to a Markdown file in a repository and to a coding agent you own (or one whose owner granted you `execute` and set `codingProfile.allowWebhookTaskOverride`, the same rule as `trigger_agent` task text):

```json
{
  "title": "Runbook",
  "markdown": "...",
  "agentId": "<coding agent id>",
  "repository": "your-org/your-repo",
  "path": "docs/runbook.md"
}
```

`repository` is `owner/name`, or `local:/abs/path` inside your trusted folders. The link cannot be added later.

## Sending

A person with `write` access selects open threads in the page and chooses "send to agent", or calls `send_threads_to_agent` with `documentId` and `threadIds` (up to 50). Wardby starts one coding run with trigger `comment`, gives the agent the current Markdown, the threads and the file path (all wrapped as untrusted content), and asks it to edit the file.

When the run ends:

1. Wardby reads the file at the run's head ref and publishes it as the next version, only if the document is still at the version that was sent. If someone published meanwhile, the edit is not applied and the agent's reply names the branch it is on.
2. The agent replies on each thread, and resolves the ones it addressed. A failed run posts one fixed reply; the threads stay open.

## Limits

- 30 sends per document per hour (`comment_send_rate_limited`).
- A thread already in a running send is refused (`comment_thread_already_sent`).
- The document must be at most 60,000 characters (`document_too_large_for_agent`).
- Share-link guests cannot send.
- The document owner needs `execute` on the agent and must own it, or the agent's owner must allow others' task text (`document_agent_unavailable`).
- `path` must be a safe repository-relative `.md` path and `baseRef` a valid branch name (`document_repo_link_invalid`).

Native agents do not edit documents yet. See [Documents](documents.md) and [Coding agent setup](../docs/coding-agent-setup.md).

## Related

- [Documents](documents.md)
