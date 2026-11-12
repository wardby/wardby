---
id: errors/share-link-invalid
title: Share link invalid (share_link_invalid)
summary: The link is unknown, expired or revoked.
audience: operator
tags: [error, documents, share_link_invalid]
appliesTo: ">=0.10.0"
---

# Share link invalid

`share_link_invalid` (HTTP 404). Wardby answers the same for an unknown, expired or revoked link. Ask the owner for a new one. The owner sees links with `list_share_links` and can revoke with `revoke_share_link`; revoking signs guests out at once. See [Share links](../document-share-links.md).

See [Documents](../documents.md).
