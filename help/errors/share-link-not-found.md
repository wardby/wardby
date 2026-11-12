---
id: errors/share-link-not-found
title: Share link not found (share_link_not_found)
summary: The share link id is unknown or belongs to another document owner.
audience: operator
tags: [error, documents, share_link_not_found]
appliesTo: ">=0.10.0"
---

# Share link not found

`share_link_not_found` (HTTP 404). `revoke_share_link` takes the link's `id` (from `create_share_link` or `list_share_links`), not its URL, and only the document's owner may revoke it.

See [Documents](../documents.md).
