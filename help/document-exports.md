---
id: document-exports
title: Exporting designs and documents
summary: Download a design board or prototype as HTML, or get a PNG or PDF of a design or a Markdown document; what each needs, where the renderer runs, how long files are kept and the error codes.
audience: operator
tags: [documents, designs, export, export_document, pdf, png, prototype, renderer, WARDBY_RENDERER_URL]
appliesTo: ">=0.10.0"
---

# Exporting designs and documents

| Format       | For                  | Result                                                               | Renderer |
| ------------ | -------------------- | -------------------------------------------------------------------- | -------- |
| `board-html` | a design             | One board's HTML file (needs `board`)                                | no       |
| `prototype`  | a design             | One HTML file with a board switcher and working links between boards | no       |
| `png`        | a design             | One board as an image (needs `board`)                                | yes      |
| `pdf`        | a design or Markdown | All boards of a design, or a paginated A4 PDF of a Markdown document | yes      |

A Markdown document exports as PDF only; its page has **Export PDF**, and a design page has an Export menu. A Markdown PDF leaves out images that are not embedded as `data:` URLs. Add `versionNumber` to export an older version.

## The renderer

PNG and PDF need the server's renderer, an optional service that runs headless Chromium over the boards. It is off unless `WARDBY_RENDERER_URL` is set. Without it the request is refused with [`export_renderer_unavailable`](errors/export-renderer-unavailable.md) and nothing is queued; HTML exports still work.

- **GKE:** `WARDBY_RENDERER=true` for `deploy/gke/up.sh` builds, applies and configures it.
- **EKS:** build the `renderer` image, apply the manifests and set `WARDBY_RENDERER_URL`, as in the AWS deployment guide.
- **Local:** `docker compose -f deploy/local/docker-compose.renderer.yml up -d`, then start the control plane with `WARDBY_RENDERER_URL=http://127.0.0.1:8796`.

The renderer pod asks for 500m CPU and 2 GiB of memory and has a health check that restarts it if Chromium crashes or renders get stuck. In [low-power mode](low-power-mode.md) it sleeps when idle; the first export after that waits for it to wake (about 20 seconds, longer on a cold node, and the wait ends after 5 minutes). Details and isolation: [Documents and designs: exports](../docs/documents.md#exports).

## Access and limits

A rendered export is kept for one hour, can be read only by the person who asked, is at most 20 MiB ([`export_too_large`](errors/export-too-large.md)), and each document allows 30 requests an hour ([`export_rate_limited`](errors/export-rate-limited.md)). Anonymous share-link readers can download HTML but must sign in, or register as a guest, to ask for PNG or PDF ([`export_sign_in_required`](errors/export-sign-in-required.md)).

## How to ask

Over MCP use `export_document` (`documentId`, `format`, `board`, `versionNumber`). For PNG and PDF it waits up to 150 seconds; if the export is still running then (for example while the renderer wakes on a cold node), it returns `{ "exportId": "...", "status": "running" }` instead of the file. Call `export_document` again with the same arguments plus that `exportId` to keep waiting for the same export; nothing new is started and it does not count against the hourly limit again. Over the page API: `GET /d/api/<id>/export` for HTML, `POST /d/api/<id>/exports` then `GET /d/api/exports/<exportId>` and `.../file` for PNG and PDF.

## Errors

[`export_format_unsupported`](errors/export-format-unsupported.md), [`export_not_found`](errors/export-not-found.md), [`export_failed`](errors/export-failed.md), plus the four linked above.

Related: [Designs](designs.md), [Documents](documents.md), [MCP](mcp.md), [Share links](document-share-links.md).
