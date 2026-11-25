---
id: comment-threads-and-agents
title: Send comment threads to a coding agent
summary: Link a document (or a design) to a repository and a coding agent, then send open comment threads to it; the agent edits the file or design directory, Wardby publishes the next version and replies on each thread.
audience: operator
tags:
  [
    documents,
    designs,
    pins,
    comments,
    send_threads_to_agent,
    coding agent,
    comment trigger,
    repository,
    version conflict,
    reconcile,
    merge,
  ]
appliesTo: ">=0.10.0"
---

# Send comment threads to a coding agent

A document can be linked, at creation or later with `link_document`, to a Markdown file in a repository and to a coding agent you own (or one whose owner granted you `execute` and set `codingProfile.allowWebhookTaskOverride`, the same rule as `trigger_agent` task text):

```json
{
  "title": "Runbook",
  "markdown": "...",
  "agentId": "<coding agent id>",
  "repository": "your-org/your-repo",
  "path": "docs/runbook.md"
}
```

`repository` is `owner/name`, or `local:/abs/path` inside your trusted folders, and must be a repository the agent is already authorized for (otherwise `document_repo_link_invalid`). The document's owner can add, change or clear the link later with `link_document` (the same arguments plus `documentId`; `unlink: true` clears it). The content is not changed, and the next send uses the new link. While threads are with the agent the link cannot change ([`document_link_busy`](errors/document-link-busy.md)).

## Designs and pins

A [design](designs.md) links to a repository **directory** instead of a file: `kind: "design"`, `path` is the directory holding `manifest.json` (`.` for the root) and `baseRef` is required (the branch the agent starts from). Its comment threads are pins on elements, and the task describes each by board, tag, first words and path. Only the files that differ from the repository at `baseRef` go in the task, which also states the [board format](design-boards-format.md) rules; Codex and Claude Code agents both work. When the run ends, the design directory at the run's head ref becomes the next version, sanitised like any publish. Everything else on this page applies to designs too.

## Sending

A person with `write` access selects open threads in the page and chooses "send to agent", or calls `send_threads_to_agent` with `documentId` and `threadIds` (up to 50). Wardby starts one coding run with trigger `comment`, gives the agent the current Markdown, the threads and the file path (all wrapped as untrusted content), and asks it to edit the file. The task text is redacted against the agent's current secret values at send time. A document that is approved or archived cannot be sent (`document_locked`).

When the run ends:

1. Wardby reads the file at the run's head ref and publishes it as the next version, if the document is still at the version that was sent. If someone published meanwhile, see [When the document changed while the agent worked](#when-the-document-changed-while-the-agent-worked).
2. The agent replies on each thread, and resolves the ones it addressed. A failed run posts one fixed reply; the threads stay open.

Open pages show the new version, the agent's replies and the resolved threads as they land, without a refresh (see [live updates](documents.md#live-updates)).

## When the document changed while the agent worked

If someone published a newer version while the run worked, Wardby never overwrites it. It tries, in order:

1. **Merge.** File by file (a design's `manifest.json` and each board; a Markdown document is one file), against the version that was sent: a file only the agent changed takes the agent's text, a file only the newer version changed keeps it, a file both changed the same way is kept. A file both changed is merged line by line when the changes do not overlap or touch: an edit to one paragraph and an edit to another, or to two separate style rules of a board, both land. Blank lines at the end of a file are set aside first, so adding or dropping one is never a conflict. Changes to the same or adjacent lines make that file a conflict (no conflict markers are ever written). If no file conflicts, the merge passes the same checks as any edit and is published as the next version, with the summary `Agent edit for comment threads #2 (merged with v3)`, and the replies and resolving happen as usual.
2. **One reconcile run.** If a file conflicts, Wardby starts one more coding run (trigger `comment`, as the person who sent the threads) on the latest version, for the threads still open (a thread resolved meanwhile is left out and gets no reply). Its task holds the current content and the agent's earlier edit (for a design, only the files it changed; when those do not fit the coding-task limit, a unified diff of each changed file instead), and asks it to re-apply its change on top of the current version, then reply. Each thread first gets the note "The document changed while the agent worked, so it is re-applying its edit on version 3." The reconcile run is checked like a send: the sender still needs `write`, the agent must still be usable for the document and its repository, the hourly limit counts it, and the task must fit. Its result is published like any send's, merge included.
3. **The note.** If the edit is too large to send back even as a diff, each thread gets "The document changed after this was sent, and the agent's edit is too large to re-apply automatically, so it was not applied. It is on branch …". If the reconcile run cannot start for another reason, or it too finds a newer version it cannot merge with (only one reconcile run per send), each thread gets "The document changed after this was sent, so the agent's edit was not applied. It is on branch …", naming the branch with the agent's edit. If the reconcile run itself fails (or times out, or is refused), each thread gets "The agent run that re-applied the edit on the newer version failed, so the document was not changed. The earlier edit is on branch …", naming the first run's branch. The threads stay open; send them again to retry.

If the document was approved or archived while the agent worked, the edit is not applied and nothing is merged or re-applied: each thread gets "The document was approved while the agent worked, so its edit was not applied. It is on branch …" (or "archived").

The same applies to designs and to Codex and Claude Code agents alike.

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
- [Documents from native agents](native-agent-documents.md) (a native writer takes sends too)
- [Review and approve documents](document-review.md) (an approved or archived document takes no agent edit)
