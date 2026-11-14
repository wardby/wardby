---
id: errors/document-link-busy
title: Document link busy (document_link_busy)
summary: link_document cannot change the link while threads are with the agent.
audience: operator
tags: [error, documents, document_link_busy, link_document]
appliesTo: ">=0.10.0"
---

# Document link busy

`document_link_busy` (HTTP 409). `link_document` refused to change or clear the document's agent and repository link because comment threads were sent and the agent has not answered yet. That run publishes its edit back through the link it started with, so the link stays until it ends.

Wait for the agent's reply on the sent threads (or for the run to fail or be stopped), then call `link_document` again.

See [Documents](../documents.md).
