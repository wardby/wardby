---
id: errors/live-unavailable
title: Live editing unavailable (live_unavailable)
summary: The page could not join live editing; it saves versions the usual way instead.
audience: operator
tags: [error, documents, live editing, live_unavailable, websocket]
appliesTo: ">=0.10.2"
---

# Live editing unavailable

`live_unavailable`. The document page could not join live editing for this document, so it saves versions the
usual way (each save names the version it started from and is refused with
[`document_version_conflict`](document-version-conflict.md) if someone published since).

Usual causes:

- A proxy or load balancer between the browser and Wardby does not pass WebSocket upgrades on `/d/live/` (allow
  them, with an idle timeout of at least a minute).
- The replica leading the document cannot be reached from the one the browser reached.
- The document is a design (designs are not edited live).

See [Live editing](../live-editing.md) and [Documents](../documents.md).
