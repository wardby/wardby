---
id: errors/comment-thread-closed
title: Comment thread closed (comment_thread_closed)
summary: A reply to a resolved thread, or a send to the agent of a thread that is not open.
audience: operator
tags: [error, documents, comment_thread_closed]
appliesTo: ">=0.10.0"
---

# Comment thread closed

`comment_thread_closed` (HTTP 409). Replying to a resolved thread is refused; open and outdated threads take replies. Sending a thread to the agent needs an open thread, so sending one that is resolved or outdated is refused. Reopen the thread in the page, or start a new thread on the current text. When several threads are sent at once and one of them changed state meanwhile, none is sent; refresh and send again.

See [Documents](../documents.md).
