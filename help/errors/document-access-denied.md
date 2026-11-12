---
id: errors/document-access-denied
title: Document access denied (document_access_denied)
summary: You can see the document but your level is too low for this action.
audience: operator
tags: [error, documents, document_access_denied]
appliesTo: ">=0.10.0"
---

# Document access denied

`document_access_denied` (HTTP 403). You hold a lower level than the action needs. Levels, lowest first: `read`, `comment`, `write`; the owner may also manage grants and share links.

- Reading and listing comments needs `read`.
- Commenting and replying needs `comment`.
- Publishing a version, resolving others' threads and sending threads to an agent needs `write`.
- `create_share_link`, `revoke_share_link` and grants need the owner.
- Guests (share-link visitors) can never send threads to an agent or create share links.

Ask the owner to raise your level with `grant_access` (`resourceType: "document"`). Granting `everyone` is capped at `comment`.

See [Documents](../documents.md).
