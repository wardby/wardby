---
id: errors/document-version-is-latest
title: Document version is already the latest (document_version_is_latest)
summary: The version you asked to restore is the newest one, so restoring it would change nothing.
audience: operator
tags: [error, documents, document_version_is_latest, versions, restore]
appliesTo: ">=0.10.0"
---

# Document version is already the latest

`document_version_is_latest` (HTTP 409). `restore_document_version` (or the Edits tray's **Restore this version**) names the version that is already the newest, so a restore would only add a copy of the current text.

What to do:

1. Pick an earlier version from `list_document_versions` (or the Edits tray).
2. If someone published since you looked, the call answers [`document_version_conflict`](document-version-conflict.md) instead; reload and choose again.

See [Documents](../documents.md).
