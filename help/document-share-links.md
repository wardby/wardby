---
id: document-share-links
title: Share a document by link, and what guests can do
summary: create_share_link gives a view or comment link for people without an account; guests pick a name, links expire and can be revoked.
audience: operator
tags: [documents, share link, guest, create_share_link, revoke_share_link, list_share_links]
appliesTo: ">=0.10.0"
---

# Share a document by link

`create_share_link` with `documentId`, `permission` (`view` or `comment`) and optional `expiresInDays` (1-90, default 14) returns `https://<your-host>/s/<token>`. The URL is shown once: Wardby stores only a hash and `list_share_links` cannot show it again. Only the document's owner can create, list or revoke links.

## What a guest can do

Opening the link, a guest enters a display name (1-40 characters; not containing "agent" or "via"; not the name of the owner or a member granted access to that document) and an optional email. They can read the current version and, with a `comment` link, start threads and reply (30 comments an hour per guest; a link accepts 20 registrations an hour). They cannot edit, see other versions, send to an agent, share, or list members to @-mention.

## Risks

Anyone holding the URL has the access; treat it like a password. Guests are not verified, so a name proves nothing. Use the shortest expiry that works, `revoke_share_link` when done (guests are signed out immediately), and do not put secrets in a shared document.

Errors: `share_link_invalid`, `guest_name_invalid`, `share_expiry_invalid`, `share_permission_invalid`, `web_rate_limited`. See [Documents](documents.md).

## Related

- [Documents](documents.md)
