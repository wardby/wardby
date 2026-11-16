---
id: errors/document-format-mismatch
title: Wrong content for this kind of document (document_format_mismatch)
summary: Markdown was given for a design, or design files for a Markdown document.
audience: operator
tags: [error, documents, designs, document_format_mismatch]
appliesTo: ">=0.10.0"
---

# document_format_mismatch

`document_format_mismatch` (HTTP 400). The request does not fit the document's kind. A Markdown document takes `markdown`; a design takes `files`. Examples: `publish_version` with `markdown` on a design, `create_document` with `kind: "design"` and `markdown` (or with neither `files` nor a repository to import from), or a Markdown-only action (such as the Markdown editor's save) on a design.

Check the document's `kind` with `get_document` or `list_documents`, then send the matching content. The kind cannot be changed after creation.

See [Designs](../designs.md) and [Documents](../documents.md).
