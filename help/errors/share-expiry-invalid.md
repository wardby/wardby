---
id: errors/share-expiry-invalid
title: Share link expiry invalid (share_expiry_invalid)
summary: expiresInDays must be a whole number from 1 to 90.
audience: operator
tags: [error, documents, share_expiry_invalid]
appliesTo: ">=0.10.0"
---

# Share link expiry invalid

`share_expiry_invalid` (HTTP 400). Share links last 14 days by default and at most 90. Pass a whole number of days between 1 and 90, or omit `expiresInDays`.

See [Documents](../documents.md).
