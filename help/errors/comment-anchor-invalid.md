---
id: errors/comment-anchor-invalid
title: Comment anchor invalid (comment_anchor_invalid)
summary: The quoted text the comment is anchored to is malformed.
audience: operator
tags: [error, documents, comment_anchor_invalid]
appliesTo: ">=0.10.0"
---

# Comment anchor invalid

`comment_anchor_invalid` (HTTP 400). A new thread carries an anchor: the quoted text (up to 500 characters) with up to 64 characters of context on each side. This code means the anchor is missing a field, too long, or not text. The bundled editor builds valid anchors; you see this only from a custom client or a stale page. Reload the page and select the text again.

See [Documents](../documents.md).
