---
id: errors/document-send-not-available
title: Send to agent not available (document_send_not_available)
summary: This server cannot start coding runs from the document page.
audience: operator
tags: [error, documents, document_send_not_available]
appliesTo: ">=0.10.0"
---

# Send to agent not available

`document_send_not_available` (HTTP 501). The control plane has no coding executor wired to the document page, so a comment posted with "send to agent" was refused whole (the comment is not created either). Use a deployment with a coding executor (`JOB_LAUNCHER`), or post the comment without sending.

See [Documents](../documents.md).
