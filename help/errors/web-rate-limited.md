---
id: errors/web-rate-limited
title: Browser rate limit reached (web_rate_limited)
summary: Too many guest registrations or comments from one link or guest, or too many live document pages open in one browser session.
audience: operator
tags: [error, documents, web_rate_limited]
appliesTo: ">=0.10.0"
---

# Browser rate limit reached

`web_rate_limited` (HTTP 429). Guests are limited to 30 comments and replies per hour each, and a share link accepts 20 guest registrations an hour. Wait and retry; the owner can create another link if one is crowded.

The live-updates stream (`GET /d/api/<id>/events`) answers the same code when one browser session already has 5 live pages open. Close a tab; the page keeps retrying and goes live once a slot is free.

See [Documents](../documents.md).
