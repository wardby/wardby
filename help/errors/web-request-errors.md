---
id: errors/web-request-errors
title: Document page request errors (invalid_request, expected_json_object, not_found, internal_error)
summary: Generic errors from the document page API: a malformed request, a missing route, or an unexpected failure.
audience: operator
tags: [error, documents, invalid_request, expected_json_object, not_found, internal_error]
appliesTo: ">=0.10.0"
---

# Document page request errors

The document page talks to JSON routes under `/d/api/`. Four generic codes can come back:

- `invalid_request` (400): a field is missing or has the wrong type. The bundled page never sends this; a stale tab or a custom client does.
- `expected_json_object` (415): the body was not a JSON object. Send `content-type: application/json`.
- `not_found` (404): no such route. Check the URL.
- `internal_error` (500): an unexpected failure. The response carries an `id`; the control plane log has an entry with the same value as `requestId` and the error's type only (never document text). Report that id.

See [Documents](../documents.md).
