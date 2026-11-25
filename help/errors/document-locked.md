---
id: errors/document-locked
title: Document locked (document_locked)
summary: The document is approved, rejected or archived (it takes no new version), or removed from its plan; its threads cannot be sent to an agent.
audience: operator
tags: [error, documents, review, document_locked]
appliesTo: ">=0.10.0"
---

# Document locked

`document_locked` (HTTP 409). The document or design is **approved**, **rejected** or **archived**. No route can publish a new version (the editor, board saves, `publish_version`, restore, agent edits), and comment threads cannot be sent to the agent. Comments still work.

A document its planner **removed from the plan** is read-only to agents: sending its threads (`send_threads_to_agent`, or **Send to agent** on the page) is refused with `document_locked`. To have the planner work on it again, ask for the file back in a comment on another document of the plan; the revision that writes the file again returns the document to the plan.

To change an approved document, someone with write access reopens it (`reopen_document`, or **Reopen for review** on the page), which puts a new version, a copy of the approved one, in review; they publish the change, and the reviewers approve again. A rejected plan document is reopened the same way, which also puts it back into its plan ([Reject](../document-review.md#reject)). To change an archived document, its owner unarchives it (`archive_document` with `archived: false`).

See [Review and approve documents](../document-review.md).
