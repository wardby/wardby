---
id: errors/comment-not-found
title: Comment or thread not found (comment_not_found)
summary: The thread or comment id is unknown, or none of the ids sent exist.
audience: operator
tags: [error, documents, comment_not_found]
appliesTo: ">=0.10.0"
---

# Comment or thread not found

`comment_not_found` (HTTP 404). The id does not match a thread or comment you can see, it was deleted, or a send listed no threads (or more than 50). Take ids from `list_comment_threads`.

See [Documents](../documents.md).
