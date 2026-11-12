---
id: errors/export-failed
title: Export failed (export_failed)
summary: The renderer failed or did not finish in time.
audience: operator
tags: [error, documents, export, export_failed]
appliesTo: ">=0.10.0"
---

# export_failed

`export_failed` (HTTP 502). The renderer failed, its output could not be used, or it did not finish in time (over MCP, `export_document` waits 150 seconds). Retry; a design with many large boards can be exported one board at a time as PNG. If it persists, check the control plane and renderer logs. If the renderer pod restarted, its health check recovered it from a crashed or stuck Chromium.

See [Exporting designs and documents](../document-exports.md).
