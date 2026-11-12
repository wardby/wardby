---
id: errors/web-csrf-failed
title: CSRF check failed (web_csrf_failed)
summary: The request lacked a valid x-wardby-csrf header.
audience: operator
tags: [error, documents, web_csrf_failed]
appliesTo: ">=0.10.0"
---

# CSRF check failed

`web_csrf_failed` (HTTP 403). Changing requests from the document page carry a per-session CSRF value. Reload the page to get a fresh one. Custom scripts cannot call these routes; use the MCP tools.

See [Documents](../documents.md).
