---
id: errors/share-permission-invalid
title: Share link permission invalid (share_permission_invalid)
summary: permission must be view or comment.
audience: operator
tags: [error, documents, share_permission_invalid]
appliesTo: ">=0.10.0"
---

# Share link permission invalid

`share_permission_invalid` (HTTP 400). `create_share_link` takes `permission`: `view` (read only) or `comment` (guests may start threads and reply). Share links never carry write access.

See [Documents](../documents.md).
