---
id: errors/document-locked
title: Document locked (document_locked)
summary: The document is approved or archived, so it takes no new version and cannot be sent to an agent.
audience: operator
tags: [error, documents, review, document_locked]
appliesTo: ">=0.10.0"
---

# Document locked

`document_locked` (HTTP 409). The document or design is **approved** or **archived**. No route can publish a new version (the editor, board saves, `publish_version`, restore, agent edits), and comment threads cannot be sent to the agent. Comments still work.

To change an approved document, someone with write access reopens it (`reopen_document`, or **Reopen for review** on the page), publishes the change, and the reviewers approve again. To change an archived document, its owner unarchives it (`archive_document` with `archived: false`).

See [Review and approve documents](../document-review.md).
