---
id: errors/comment-thread-closed
title: Comment thread closed (comment_thread_closed)
summary: The thread is resolved, outdated or already in a send.
audience: operator
tags: [error, documents, comment_thread_closed]
appliesTo: ">=0.10.0"
---

# Comment thread closed

`comment_thread_closed` (HTTP 409). The action needs an open thread. Replying to a resolved thread, or sending one that is resolved or outdated, is refused. Reopen the thread in the page, or start a new thread on the current text. When several threads are sent at once and one of them changed state meanwhile, none is sent; refresh and send again.

See [Documents](../documents.md).
