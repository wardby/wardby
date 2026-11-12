---
id: errors/export-renderer-unavailable
title: Export failed (export_renderer_unavailable)
summary: The server has no renderer, or it could not be reached or woken.
audience: operator
tags: [error, documents, export, export_renderer_unavailable]
appliesTo: ">=0.10.0"
---

# export_renderer_unavailable

`export_renderer_unavailable` (HTTP 503). The server has no renderer, or it could not be reached or woken. HTML exports still work. Operators: the renderer is optional; turn it on with `WARDBY_RENDERER=true` for `deploy/gke/up.sh` (or see the GKE and AWS deployment guides) so `WARDBY_RENDERER_URL` is set. In [low-power mode](../low-power-mode.md) the first export after an idle period waits up to 2 minutes for the renderer to wake; if it cannot, the export fails with this code and a retry usually works.

See [Exporting designs and documents](../document-exports.md).
