---
id: errors/document-summary-invalid
title: Document summary not allowed (document_summary_invalid)
summary: A version summary reading "Restored v<N>" is reserved for real restores.
audience: operator
tags: [error, documents, document_summary_invalid, publish_version, restore]
appliesTo: ">=0.10.0"
---

# Document summary not allowed

`document_summary_invalid` (HTTP 400). `publish_version` refuses a `summary` that begins with "Restored v" followed by a number. The Edits tray and `list_document_versions` recognise restores by that text, so only `restore_document_version` may write it.

What to do:

1. Word the summary differently (for example "Reverted the pricing section").
2. To go back to an earlier version, call `restore_document_version`.

See [Documents](../documents.md).
