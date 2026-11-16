---
id: errors/document-not-found
title: Document not found (document_not_found)
summary: The document id is unknown, or you have no access to it.
audience: operator
tags: [error, documents, document_not_found]
appliesTo: ">=0.10.0"
---

# Document not found

`document_not_found` (HTTP 404). The document does not exist, or you cannot see it. Wardby answers the same way for both so that a stranger cannot learn which ids exist. A document's current version missing (an empty document) also returns this.

What to do:

1. Check the id from `list_documents` (the `documentId` field), not the page title.
2. Ask the owner to share it: `grant_access` with `resourceType: "document"` at `read`, or send a share link.
3. Signed in as someone else? The browser page and MCP use the same person, so sign in as the account the document was shared with.

See [Documents](../documents.md).
