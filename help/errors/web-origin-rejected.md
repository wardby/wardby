---
id: errors/web-origin-rejected
title: Request origin rejected (web_origin_rejected)
summary: The Origin header does not match the server's canonical origin.
audience: operator
tags: [error, documents, web_origin_rejected]
appliesTo: ">=0.10.0"
---

# Request origin rejected

`web_origin_rejected` (HTTP 403). Changing requests must come from the page served at `MCP_CANONICAL_URI`'s origin. If you proxy the pages, make sure the proxy forwards the `Origin` header and the browser reaches the same origin as `MCP_CANONICAL_URI`.

See [Documents](../documents.md).
