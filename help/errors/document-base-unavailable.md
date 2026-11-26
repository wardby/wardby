---
id: errors/document-base-unavailable
title: Base version no longer kept (document_base_unavailable)
summary: A publish to a live document named a base version too old to merge from.
audience: operator
tags: [error, documents, live editing, publish_version, baseNumber, document_base_unavailable]
appliesTo: ">=0.10.2"
---

# Base version no longer kept

`document_base_unavailable` (HTTP 409). A document being edited live merges a publish based on an older version
with everything published since. That needs the older version's merge state, which is kept for the 50 newest
versions only; the `baseNumber` you sent is older than that.

Read the document again (`get_document` returns the current version number) and redo the change on it, then
publish with that `baseNumber`.

See [Documents](../documents.md) and [`document_version_conflict`](document-version-conflict.md).
