---
id: errors/document-too-large-for-agent
title: Document too large for the agent (document_too_large_for_agent)
summary: The document is over 60,000 characters, the most that can be sent to a coding agent.
audience: operator
tags: [error, documents, document_too_large_for_agent]
appliesTo: ">=0.10.0"
---

# Document too large for the agent

`document_too_large_for_agent` (HTTP 413). Wardby sends the current Markdown to the agent along with the threads, so the document plus the comments must fit one task. Above 60,000 characters (or when the threads leave no room), the send is refused before any run starts.

Split the document into smaller files, or edit it by hand.

See [Documents](../documents.md).
