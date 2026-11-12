---
id: documents
title: Documents - write, comment and review Markdown with people and a coding agent
summary: Create Markdown documents, share them with people or by link, collect anchored comments, and send open threads to a coding agent that edits the file in a repository.
audience: operator
tags: [documents, markdown, comments, create_document, publish_version, share, send_threads_to_agent, live updates]
appliesTo: ">=0.10.0"
---

# Documents

A document is a Markdown file with versions and comment threads, opened in a browser at `https://<your-host>/d/<documentId>`. People edit it in the page; agents and scripts use MCP tools. The full guide is [docs/documents.md](../docs/documents.md).

## Quick start

1. `create_document` with a `title` and `markdown` (at most 1 MiB). The result has the `documentId` and `url`. Over stdio without `MCP_CANONICAL_URI`, it gives `path` (`/d/<id>`) and a note instead of `url`: open the path on the address that serves Wardby's pages.
2. Open the URL and sign in (self-hosted users reuse their Wardby sign-in; with a delegating identity provider see [Browser sign-in](web-sign-in.md)).
3. Select text and add a comment. Threads stay anchored to the quoted text across versions; a thread whose text is deleted is marked outdated.
4. Share: `grant_access` with `resourceType: "document"` at `read`, `comment` or `write` for a person, or a [share link](document-share-links.md) for people who have no account.
5. `publish_version` replaces the content (the page also saves versions).

## Tools

- Documents: `create_document`, `publish_version`, `get_document`, `list_documents`.
- Comments: `list_comment_threads`, `get_comment_thread`, `reply_to_thread`, `resolve_thread`.
- Sharing: `create_share_link`, `list_share_links`, `revoke_share_link`, and `grant_access` / `revoke_access` / `list_access` for people.
- Agents: `send_threads_to_agent` (see [Comment threads and agents](comment-threads-and-agents.md)).

They need the `documents:read` and `documents:write` scopes; `send_threads_to_agent` also needs `runs:trigger`. No Wardby role is required. Define the scopes at your identity provider (see [Identity and access](identity-and-access.md)).

## Mentions

Type `@` in a comment to mention someone. Members can mention members and the guests who have commented on this document (shown as "Name (guest)"). Guests get no list. A mention of a guest from another document shows as "@unknown". Wardby stores and highlights mentions but sends no notification yet.

## Live updates

Open pages update without a refresh: new comments, replies, resolved threads and new versions appear as they happen. A new version loads in place unless you have unsaved edits (then the page asks you to reload). "Offline — reconnecting" shows while the page is not connected; a tab hidden for 5 minutes stops listening and catches up when you return. One browser session can hold at most 5 live pages. Behind a proxy, the stream `GET /d/api/<id>/events` (`text/event-stream`) must not be buffered and needs an idle timeout above the 15-second heartbeat. Details: [Live updates](../docs/documents.md#live-updates).

## Treat text as untrusted

Document text and comments are written by people. Tool results wrap them as untrusted content; an agent reading them should treat them as data. Secret values of the linked agent are removed from document and comment text before they are stored.

## Errors

Codes such as `document_not_found`, `document_access_denied` and `document_too_large` have articles under `errors/` (search the code).

## Related

- [Share a document by link](document-share-links.md)
- [Send comment threads to a coding agent](comment-threads-and-agents.md)
- [Browser sign-in for document pages](web-sign-in.md)
