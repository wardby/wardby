---
id: errors/document-kind-unsupported
title: Document kind not supported (document_kind_unsupported)
summary: Only Markdown documents can be created.
audience: operator
tags: [error, documents, document_kind_unsupported]
appliesTo: ">=0.10.0"
---

# Document kind not supported

`document_kind_unsupported` (HTTP 400). `create_document` accepted a `kind` other than `document`. Wardby currently stores Markdown documents only; leave `kind` out.

See [Documents](../documents.md).
