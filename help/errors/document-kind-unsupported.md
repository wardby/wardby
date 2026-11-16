---
id: errors/document-kind-unsupported
title: Document kind not supported (document_kind_unsupported)
summary: Only Markdown documents can be created.
audience: operator
tags: [error, documents, document_kind_unsupported]
appliesTo: ">=0.10.0"
---

# Document kind not supported

`document_kind_unsupported` (HTTP 400). The document kind has no handler: `create_document` takes `kind` `document` (the default) or `design`. Anything else is refused. See [Designs](../designs.md).

See [Documents](../documents.md).
