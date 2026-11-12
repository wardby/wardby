---
id: comment-threads-and-agents
title: Send comment threads to a coding agent
summary: Link a document (or a design) to a repository and a coding agent, then send open comment threads to it; the agent edits the file or design directory, Wardby publishes the next version and replies on each thread.
audience: operator
tags: [documents, designs, pins, comments, send_threads_to_agent, coding agent, comment trigger, repository]
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

`repository` is `owner/name`, or `local:/abs/path` inside your trusted folders, and must be a repository the agent is already authorized for (otherwise `document_repo_link_invalid`). The link cannot be added later.

## Designs and pins

A [design](designs.md) links to a repository **directory** instead of a file: `kind: "design"`, `path` is the directory holding `manifest.json` (`.` for the root) and `baseRef` is required (the branch the agent starts from). Its comment threads are pins on elements, and the task describes each by board, tag, first words and path. Only the files that differ from the repository at `baseRef` go in the task, which also states the [board format](design-boards-format.md) rules; Codex and Claude Code agents both work. When the run ends, the design directory at the run's head ref becomes the next version, sanitised like any publish. Everything else on this page applies to designs too.

## Sending

A person with `write` access selects open threads in the page and chooses "send to agent", or calls `send_threads_to_agent` with `documentId` and `threadIds` (up to 50). Wardby starts one coding run with trigger `comment`, gives the agent the current Markdown, the threads and the file path (all wrapped as untrusted content), and asks it to edit the file. The task text is redacted against the agent's current secret values at send time.

When the run ends:

1. Wardby reads the file at the run's head ref and publishes it as the next version, only if the document is still at the version that was sent. If someone published meanwhile, the edit is not applied and the agent's reply names the branch it is on.
2. The agent replies on each thread, and resolves the ones it addressed. A failed run posts one fixed reply; the threads stay open.

Open pages show the new version, the agent's replies and the resolved threads as they land, without a refresh (see [live updates](documents.md#live-updates)).

## Limits

- 30 sends per document per hour (`comment_send_rate_limited`).
- A thread already in a running send is refused (`comment_thread_already_sent`).
- The document must be at most 60,000 characters, and a design's changed files, the threads and the agent's instructions must fit the 64 KiB coding task (`document_too_large_for_agent`).
- Share-link guests cannot send.
- The document owner needs `execute` on the agent and must own it, or the agent's owner must allow others' task text (`document_agent_unavailable`).
- `path` must be a safe repository-relative `.md` path and `baseRef` a valid branch name (`document_repo_link_invalid`).

Native agents do not edit documents yet. See [Documents](documents.md) and [Coding agent setup](../docs/coding-agent-setup.md).

## Related

- [Documents](documents.md)
