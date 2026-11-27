---
id: live-editing
title: Live editing - edit documents and designs together, comments that follow their words
summary: Everyone with a document or design open edits one copy live, with named carets (documents) or named outlines (designs); comments and pins stay on their words or elements through every edit; versions are saved as checkpoints; publishes merge in. How it works, what to set for several control-plane copies (WARDBY_LIVE_REDIS_URL, WARDBY_LIVE_ADVERTISE_ADDRESS) and what each error means.
audience: operator
tags:
  [
    live editing,
    co-editing,
    collaboration,
    edit together,
    carets,
    designs,
    live design,
    presence,
    pins,
    WebSocket,
    /d/live,
    WARDBY_LIVE_REDIS_URL,
    WARDBY_LIVE_ADVERTISE_ADDRESS,
    live_state_stale,
    edit_refused,
    live_unavailable,
    document_base_unavailable,
  ]
appliesTo: ">=0.10.2"
---

# Live editing

Everyone with a Markdown [document](documents.md) or a [design](designs.md) open edits the same copy at the same time. Changes appear for the others as they happen, with each person's named caret (or, on a design, an outline of what they selected), and no one is locked out by someone else's save. The page's save state reads **Live**.

## What people see

- **Who edits:** members with `write`. Members and guests with `comment` or `read` watch the edits arrive. An approved, rejected or archived document is read-only for everyone, at once.
- **Comments follow their words.** A comment keeps its place through everyone's edits, including edits inside the commented words; it is marked outdated only when its words are deleted, and opens again if that deletion is undone. A comment can cover up to 10,000 characters.
- **Versions** are saved after 3 seconds without edits (at most every 15 seconds while edits continue), credited to whoever edited last. History, review, exports and every MCP tool keep working from versions. Opening a document saves nothing.
- **Designs** are edited live board by board: the first person to open a board builds its live copy and the others join it; changes arrive element by element, others' selections show as outlines with their names, and Undo undoes your own changes only. See [Edit together](designs.md#edit-together).

## Publishing to a live document

`publish_version` takes the version you read as `baseNumber`. On a live document, a change based on an older version is merged with everything published since (word by word in a document, element by element in a design; a design board nobody has opened is taken as a whole file, and a publish that changes one a later version also changed is `document_version_conflict`): the saved version is the whole document with both changes, and everyone with the page open sees it arrive. Threads sent to a coding agent merge the same way. The merge needs the older version's state, kept for the 50 newest versions; an older base is [`document_base_unavailable`](errors/document-base-unavailable.md).

A version with formatting the editor cannot keep (images, checklists, HTML) ends live editing for that document instead of dropping that content; such documents open comment-only, as before.

## Deploying

- The page connects to `wss://<your-host>/d/live/<documentId>` with its browser session. Proxies and load balancers must pass WebSocket upgrades on `/d/live/` and allow idle connections of at least a minute. On Google Cloud's load balancer the backend timeout also caps a WebSocket's lifetime: the GKE manifests and the Helm chart set an hour, after which the page reconnects by itself.
- **Several control-plane copies.** By default each document is served by one copy at a time (a lease in PostgreSQL); the others hand its connections to that copy at its advertise address. The GKE manifests and the Helm chart set `WARDBY_LIVE_ADVERTISE_ADDRESS` to the pod's IP and port; elsewhere Wardby uses the machine's first non-internal IPv4 address. Set it (`host:port`) on separate machines with several networks or NAT. If a copy stops without warning, its documents pause until its lease expires (30 seconds).
- **Redis (optional).** With `WARDBY_LIVE_REDIS_URL` (`redis://` or `rediss://`; it may carry a password, so keep it in a secret) every copy serves every document and edits pass between copies through Redis; a copy stopping no longer pauses editing. While Redis is configured but unreachable, a copy reports itself not ready. Platforms whose instances cannot reach each other (Cloud Run) need one copy, or Redis.

See [Availability](../docs/availability.md) and [Documents](../docs/documents.md#live-editing).

## Errors

- [`live_unavailable`](errors/live-unavailable.md): the page could not join (no WebSocket through a proxy, the leading copy unreachable, or a document that cannot go live); it saves versions the usual way.
- [`live_state_stale`](errors/live-state-stale.md): the page held a copy from a history the server no longer has; it reloads.
- [`edit_refused`](errors/edit-refused.md): an edit would have shown a secret value, broken a design's board format or made a board larger than 512 KB (or changed the server's own record in the document); no one else received it, and the page reloads.
- [`document_base_unavailable`](errors/document-base-unavailable.md): a publish's base version is too old to merge from.
