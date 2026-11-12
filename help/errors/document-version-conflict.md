---
id: errors/document-version-conflict
title: Document version conflict (document_version_conflict)
summary: Someone published a newer version while you were editing.
audience: operator
tags: [error, documents, document_version_conflict]
appliesTo: ">=0.10.0"
---

# Document version conflict

`document_version_conflict` (HTTP 409). The editor sends the version number it started from. Another version was published in the meantime (a colleague, an agent run, or `publish_version`), so your save was refused rather than overwriting it.

Reload the page, copy your changes out if you need to, and edit the new version. Open comment threads stay anchored to the text they quote across versions; a thread whose quoted text is gone is marked outdated.

See [Documents](../documents.md).
