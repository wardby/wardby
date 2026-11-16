---
id: errors/comment-thread-already-sent
title: Comment thread already sent (comment_thread_already_sent)
summary: The thread is part of a run that has not finished.
audience: operator
tags: [error, documents, comment_thread_already_sent]
appliesTo: ">=0.10.0"
---

# Comment thread already sent

`comment_thread_already_sent` (HTTP 409). A thread is sent to an agent once at a time. Wait for the run to end (the agent replies on the thread), or stop the run with `stop_run` and send again. Find the run with `list_runs` (trigger `comment`).

See [Documents](../documents.md).
