---
id: errors/comment-send-rate-limited
title: Send rate limit reached (comment_send_rate_limited)
summary: 30 sends per document per hour is the limit.
audience: operator
tags: [error, documents, comment_send_rate_limited]
appliesTo: ">=0.10.0"
---

# Send rate limit reached

`comment_send_rate_limited` (HTTP 429). Each send starts a coding run, so a document accepts at most 30 sends an hour. Batch more threads into one send (up to 50 threads per send) and retry after the window passes.

See [Documents](../documents.md).
