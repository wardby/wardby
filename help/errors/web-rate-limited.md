---
id: errors/web-rate-limited
title: Browser rate limit reached (web_rate_limited)
summary: Too many guest registrations or comments from one link or guest.
audience: operator
tags: [error, documents, web_rate_limited]
appliesTo: ">=0.10.0"
---

# Browser rate limit reached

`web_rate_limited` (HTTP 429). Guests are limited to 30 comments and replies per hour each, and a share link accepts 20 guest registrations an hour. Wait and retry; the owner can create another link if one is crowded.

See [Documents](../documents.md).
