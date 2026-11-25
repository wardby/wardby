---
id: errors/document-too-large-for-agent
title: Document too large for the agent (document_too_large_for_agent)
summary: The document is over 60,000 characters, or the design files and threads do not fit the 64 KiB coding task.
audience: operator
tags: [error, documents, document_too_large_for_agent]
appliesTo: ">=0.10.0"
---

# Document too large for the agent

`document_too_large_for_agent` (HTTP 413). Wardby sends the current content to the agent along with the threads, so both plus the agent's own instructions must fit one coding task (64 KiB). A Markdown document is refused above 60,000 characters. For a design, only the files that differ from the repository at `baseRef` are sent; if those files, the instructions and the threads still do not fit, the send is refused. When the threads leave no room, it is refused too. No run starts. A native agent's `doc_get` has the same 60,000-character cap: it refuses a larger document or design with this code.

Split the document into smaller files, or edit it by hand. For a design, commit the boards to the repository at `baseRef` first so fewer files differ, or send fewer threads.

See [Documents](../documents.md).
