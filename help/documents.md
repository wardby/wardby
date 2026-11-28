---
id: documents
title: Documents and designs - write, comment and review Markdown or HTML boards with people and a coding agent
summary: Create Markdown documents or designs (HTML boards), share them with people or by link, collect anchored comments, export them, and send open threads to a coding agent that edits the files in a repository.
audience: operator
tags:
  [
    documents,
    markdown,
    comments,
    deleted comments,
    create_document,
    publish_version,
    share,
    send_threads_to_agent,
    live updates,
  ]
appliesTo: ">=0.10.0"
---

# Documents

A document is a Markdown file (or a [design](designs.md): a set of HTML boards) with versions and comment threads, opened in a browser at `https://<your-host>/d/<documentId>`. People edit it in the page; agents and scripts use MCP tools. The full guide is [docs/documents.md](../docs/documents.md).

## Quick start

1. `create_document` with a `title` and `markdown` (at most 1 MiB). The result has the `documentId` and `url`. Over stdio without `MCP_CANONICAL_URI`, it gives `path` (`/d/<id>`) and a note instead of `url`: open the path on the address that serves Wardby's pages.
2. Open the URL and sign in (self-hosted users reuse their Wardby sign-in; with a delegating identity provider see [Browser sign-in](web-sign-in.md)).
3. Select text and add a comment. Everyone with the page open edits together live (see [Live editing](live-editing.md)), and a comment follows its words through everyone's edits; a thread whose words are deleted is marked outdated.
4. Share: `grant_access` with `resourceType: "document"` at `read`, `comment` or `write` for a person, or a [share link](document-share-links.md) for people who have no account (**Share** in the page's top bar copies a comment link; owners and writers).
5. `publish_version` replaces the content (the page also saves versions). Pass `baseNumber`, the version you read: a newer version published since refuses the call with `document_version_conflict`.

To link one document or design from another, use its page path in a Markdown link, such as `[Wireframes](/d/<documentId>)`: it works on any host that serves Wardby. In the page, a link opens with a plain click when the page is read-only; while editing, a click places the cursor, so Cmd-click (Ctrl-click on Windows and Linux) opens it, or use **Open** on the card that shows where a link goes when the cursor is in it. A Wardby page opens in the same tab, any other site in a new tab.

## Tools

- Documents and designs (`kind: "design"` takes `files` instead of `markdown`): `create_document`, `publish_version`, `get_document` (`versionNumber` for an earlier version), `list_documents`, and `link_document` to link a document you own to a coding agent and repository file later (or change or clear the link).
- Versions: `list_document_versions`, `restore_document_version`.
- Comments: `list_comment_threads`, `get_comment_thread`, `reply_to_thread`, `resolve_thread`.
- Sharing: `create_share_link`, `list_share_links`, `revoke_share_link`, and `grant_access` / `revoke_access` / `list_access` for people.
- Export: `export_document` (see [Exports](document-exports.md)).
- Review: `submit_for_review`, `review_document`, `force_approve_document`, `reject_document`, `choose_plan_option`, `reopen_document`, `archive_document`, `wait_for_review` (see [Review and approve documents](document-review.md)).
- Agents: `send_threads_to_agent` (see [Comment threads and agents](comment-threads-and-agents.md)).

They need the `documents:read` and `documents:write` scopes; `send_threads_to_agent` also needs `runs:trigger`. No Wardby role is required. Define the scopes at your identity provider (see [Identity and access](identity-and-access.md)).

## Designs

A design is a document of kind `design`: HTML boards you edit visually, comment on with pins, view in Overview, click through in Play, export, and send to a coding agent. Start with [Designs](designs.md) and the [board format](design-boards-format.md).

## Deleting comments

You can delete your own comments (from a thread's ⋯ menu, or over the page API). Deleting a comment that has replies after it leaves "Comment deleted" in its place, so the replies keep their context; its text and author are no longer shown anywhere, and whoever started the thread keeps the right to resolve and reopen it. A deleted comment after the last remaining one simply goes. When every comment of a thread is deleted, the thread is gone for everyone: no highlight or pin, no row in the comments panel, and the MCP and agent tools treat it as unknown ([`comment_not_found`](errors/comment-not-found.md)). Its number is not reused.

## Mentions

Type `@` in a comment to mention someone. Members can mention members and the guests who have commented on this document (shown as "Name (guest)"). Guests get no list. A mention of a guest from another document shows as "@unknown". Wardby stores and highlights mentions but sends no notification yet.

## Live updates

Open pages update without a refresh: new comments, replies, resolved threads and new versions appear as they happen. A new version loads in place unless you have unsaved edits (then the page asks you to reload). "Offline — reconnecting" shows while the page is not connected; a tab hidden for 5 minutes stops listening and catches up when you return. One browser session can hold at most 5 live pages on each server replica. Behind a proxy, the stream `GET /d/api/<id>/events` (`text/event-stream`) must not be buffered and needs an idle timeout above the 15-second heartbeat. Details: [Live updates](../docs/documents.md#live-updates).

## History tab and restore

The side panel's **History** tab lists every version with who made it, how and when; click one to see its changes inline, and restore it as a new version. See [Document edits and restore](document-edits.md).

## Treat text as untrusted

Document text and comments are written by people. Tool results wrap them as untrusted content; an agent reading them should treat them as data. Secret values of the linked agent are removed from document and comment text before they are stored.

## Errors

Codes such as `document_not_found`, `document_access_denied`, `document_too_large`, `board_format_invalid` and the `export_*` codes have articles under `errors/` (search the code).

## Related

- [Route work from reviews](route-work-from-reviews.md): a router agent decides who works next when a document is acted on in review
- [Designs](designs.md) and the [board format](design-boards-format.md)
- [Exporting designs and documents](document-exports.md)
- [Document edits and restore](document-edits.md)
- [Review and approve documents](document-review.md)
- [Plan documents](plan-documents.md)
- [Share a document by link](document-share-links.md)
- [Send comment threads to a coding agent](comment-threads-and-agents.md)
- [Documents from native agents](native-agent-documents.md)
- [Browser sign-in for document pages](web-sign-in.md)
