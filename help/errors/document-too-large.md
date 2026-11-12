---
id: errors/document-too-large
title: Document too large (document_too_large)
summary: The Markdown is over 1 MiB (1,048,576 bytes).
audience: operator
tags: [error, documents, document_too_large]
appliesTo: ">=0.10.0"
---

# Document too large

`document_too_large` (HTTP 413). A version is at most 1 MiB of UTF-8 Markdown. `create_document`, `publish_version` and saves from the browser editor are refused above that, and nothing is stored.

Split the document, or remove embedded data (images pasted as base64 are the usual cause). Links to images are fine. The limit counts bytes, not characters, so non-Latin text counts for more.

See [Documents](../documents.md).
