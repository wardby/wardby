---
id: errors/document-version-not-found
title: Document version not found (document_version_not_found)
summary: The document exists, but it has no version with that number.
audience: operator
tags: [error, documents, document_version_not_found, versions, restore]
appliesTo: ">=0.10.0"
---

# Document version not found

`document_version_not_found` (HTTP 404). You can read the document, but the version number you asked for (`get_document` `versionNumber`, `restore_document_version`, or the page's Edits tray) does not exist. Versions are numbered from 1 and never deleted, so the number is past the latest one.

What to do:

1. List the versions with `list_document_versions` (or open the Edits tray on the document page) and pick a number from it.
2. If you meant the latest version, leave the number out of `get_document`.

See [Documents](../documents.md).
