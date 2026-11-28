---
id: document-share-links
title: Share a document by link, and what guests can do
summary: Share on the page or create_share_link gives a view or comment link for people without an account; owners and writers make them; guests pick a name, links expire and can be revoked.
audience: operator
tags:
  [
    documents,
    share link,
    share button,
    comment link,
    guest,
    create_share_link,
    revoke_share_link,
    list_share_links,
    guest mentions,
  ]
appliesTo: ">=0.10.0"
---

# Share a document by link

`create_share_link` with `documentId`, `permission` (`view` or `comment`) and optional `expiresInDays` (1-90, default 14) returns `https://<your-host>/s/<token>`. The URL is shown once: Wardby stores only a hash and `list_share_links` cannot show it again. Over stdio without `MCP_CANONICAL_URI`, the result has `path` (`/s/<token>`) and a note instead of `url`. The document's owner and people with `write` access can create links (agents and guests cannot). The owner lists and revokes every link on the document; a writer lists and revokes only the links they made (revoking another's is refused with `document_access_denied`).

## The Share button

On a document or design page, members with `write` access see **Share** in the top bar. One click makes a comment link (default expiry, 14 days) and copies it: "Comment link copied. Anyone with it can read and comment for 14 days." If the browser blocks the copy, the link shows in a read-only box with **Copy**; Escape or a click elsewhere closes it, and the link is not shown again. The reviewer picker's **Create comment link** does the same from the Review tab.

## What a guest can do

Opening the link, a guest enters a display name (1-40 characters; not containing "agent" or "via"; not the name of the owner or a member granted access to that document) and an optional email. They can read the current version and, with a `comment` link, start threads and reply (30 comments an hour per guest; a link accepts 20 registrations an hour). They cannot edit, see other versions, send to an agent, share, or list people to @-mention; once a guest has commented, members can @-mention them on that document. A registered guest's page updates live, like a member's.

## Risks

Anyone holding the URL has the access; treat it like a password. Guests are not verified, so a name proves nothing. Use the shortest expiry that works, `revoke_share_link` when done (guests are signed out immediately, and their open pages stop updating), and do not put secrets in a shared document.

Errors: `share_link_invalid`, `share_link_not_found`, `document_access_denied`, `guest_name_invalid`, `share_expiry_invalid`, `share_permission_invalid`, `web_rate_limited`. See [Documents](documents.md).

## Related

- [Documents](documents.md)
