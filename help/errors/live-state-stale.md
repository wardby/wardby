---
id: errors/live-state-stale
title: Live editing history changed (live_state_stale)
summary: The page held an earlier history of a live document; it reloads from the server's copy.
audience: operator
tags: [error, documents, live editing, live_state_stale]
appliesTo: ">=0.10.2"
---

# Live editing history changed

`live_state_stale`. A document page joined live editing with a copy of the document from a history the server no
longer has: the live document was reset (for example, its saved live state was removed) while the page was open.
Merging that copy in would duplicate the document, so the server refuses it and the page reloads from the
server's copy.

Anything typed on that page after its last save may be lost; the document's versions are unchanged. If it keeps
happening, check that the control plane's database is the same one for every replica.

See [Live editing](../live-editing.md) and [Documents](../documents.md).
