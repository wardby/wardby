---
id: document-exports
title: Exporting designs and documents
summary: Download a board or a whole prototype as HTML, or get a PNG or PDF; what each needs and how long it is kept.
audience: operator
tags: [documents, designs, export, export_document, pdf, png, prototype]
appliesTo: ">=0.10.0"
---

# Exporting designs and documents

- `board-html`: one board's HTML file. No renderer needed.
- `prototype`: one HTML file with a board switcher and working links between boards. No renderer needed.
- `png`: one board as an image (needs `board`).
- `pdf`: all boards of a design, or a Markdown document, as a PDF.

PNG and PDF need the server's renderer (an optional service the operator turns on). Without one the request is refused with [`export_renderer_unavailable`](errors/export-renderer-unavailable.md). A Markdown PDF leaves out images that are not embedded as `data:` URLs. A rendered export is kept for one hour, can be read only by the person who asked, and each document allows 30 requests an hour. Anonymous share-link readers can download HTML but must sign in to ask for PNG or PDF.

Over MCP use `export_document` (`documentId`, `format`, `board`, `versionNumber`); it waits up to 150 seconds. Over the page API: `GET /d/api/<id>/export` for HTML, `POST /d/api/<id>/exports` then `GET /d/api/exports/<exportId>` and `.../file` for PNG and PDF.

Related: [Documents](documents.md), [MCP](mcp.md), [Share links](document-share-links.md).
