---
id: errors/guest-name-invalid
title: Guest name invalid (guest_name_invalid)
summary: The name must be 1-40 characters, not use "agent" or "via", and not match someone on the document.
audience: operator
tags: [error, documents, guest_name_invalid]
appliesTo: ">=0.10.0"
---

# Guest name invalid

`guest_name_invalid` (HTTP 400). A guest picks a display name when opening a share link. It is refused when it is empty after trimming, over 40 characters, contains the words "agent" or "via" (so a guest cannot pose as an agent or an attributed edit), or matches the name of the document's owner or a member granted access to it (case-insensitive, after Unicode normalization). Two guests may pick the same name; each is shown with "(guest)". Choose another name. Names are always shown escaped.

See [Documents](../documents.md).
