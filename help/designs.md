---
id: designs
title: Designs - boards you edit visually, comment on with pins and share
summary: A design is a set of HTML boards with versions. Create one with create_document, edit it together in the browser (live), pin comments to elements, view all boards (Overview), click through them (Play), export it, and send pin threads to a coding agent.
audience: operator
tags:
  [
    designs,
    boards,
    grapesjs,
    pins,
    play,
    overview,
    live editing,
    edit together,
    presence,
    create_document,
    export_document,
  ]
appliesTo: ">=0.10.0"
---

# Designs

A design is a document of kind `design`: a `manifest.json` and one HTML file per **board** (screen), opened in the browser at `https://<your-host>/d/<documentId>` like a Markdown [document](documents.md). Versions, grants, [share links](document-share-links.md), live updates and the [Edits and restore](document-edits.md) tools work the same. The full guide is [Documents and designs](../docs/documents.md#designs).

## Create one

`create_document` with `kind: "design"` and either:

- `files`: a map of path to text (`manifest.json`, `boards/<id>.html`, optional `brand.md`), following the [board format](design-boards-format.md); or
- a coding `agentId`, `repository`, `path` (the directory with `manifest.json`; `.` for the root) and `baseRef`, with no `files`: Wardby imports the design from that directory at that branch.

The result has the `documentId`, `url` and any `warnings` (scripts removed, a board over 40 KB). A design cannot be created from the browser. A document or design can only be linked to a repository its agent is already authorized for. Publish changes with `publish_version` and a full `files` map; read a design with `get_document`. The full file set travels in one MCP request (at most 1 MiB), so a design over about 1 MiB cannot be updated over MCP: change it in the editor or send its threads to the agent. Importing from a repository only creates a design.

Files that break the format are refused with [`board_format_invalid`](errors/board-format-invalid.md); asking for Markdown on a design (or files on a document) gives [`document_format_mismatch`](errors/document-format-mismatch.md).

## Edit

The boards are tabs above the canvas (two lines of them, then "+N more" with a filter for the rest). People with `write` access get a visual editor: board actions in each tab's ⋯ menu and **+** to add one, **Layers** at the bottom of the left panel (closed until you open it; the page remembers), Desktop, Tablet and Phone widths and Undo/Redo on the row under the top bar, and Style and Settings tabs (right). A board's CSS as written stays in a base layer that always renders as written; when the page saves the usual way (not live), it lists styles the editor cannot change as "N styles may not be editable on board X" under Checks. Readers and commenters see the boards, Comments and History. An approved, rejected or archived design is read-only for everyone (see [Review and approve documents](document-review.md)); Style, Settings, Layers and + Board are hidden, and comments still work. A design that is approved while open turns read-only in place. Reopen for review creates a new version (a copy of the approved one) and puts it in review; the approved version stays in History as the approved record. After a reopen, a page that was editable when the lock landed is editable again in place; a page opened read-only must be reloaded to edit.

## Edit together

A design is edited [live](live-editing.md), like a document, and the save state reads **Live**:

- The first person to open a board builds its live copy from the version's file; everyone else on that board joins it. Changes arrive element by element as they are made, text as it is typed. If two people move one element at the same moment, the later move stays.
- Other people's selections are outlined in their colour with their name ("is typing" while they type in a text box), and each board's tab shows a dot per person on it. Adding, renaming, moving and deleting boards is shared too.
- Undo and Redo undo your own changes only.
- The server saves the whole file set as a version after a pause in editing. The page saves nothing itself.
- Each edit is checked first: one that breaks the [board format](design-boards-format.md), makes a board larger than 512 KB or would show a secret value is refused ([`edit_refused`](errors/edit-refused.md)) and the page reloads.
- `publish_version` from an agent or MCP merges into the live boards element by element from the version it read, so people's edits made meanwhile stay. A board nobody has opened takes the published file; a publish that changes such a board after a later version also changed it is `document_version_conflict`.

When the page cannot join (no WebSocket through a proxy), edits save by themselves as a new version that holds only the changed files, as before.

## Comment with pins

Press `C`, click an element and write the comment. The thread is a pin on that element and stays on it at every width, and, while the design is edited live, through everyone's edits and agents' versions. A resolved pin shows only while selected; a thread whose element is deleted (live) or that a new version removes is marked outdated.

## Overview, Play and History

- **Overview** shows every board as a tile; pick one to open it.
- **Play** is a click-through prototype: `#board:<id>` links move between boards.
- **History** lists versions; open one to see it read-only, and **Restore this version** (with `write`) publishes it as a new version.

## Export

HTML (one board, or a whole prototype) needs nothing; PNG and PDF need the optional renderer. See [Exporting designs and documents](document-exports.md).

## Send pins to a coding agent

A design linked to a repository directory and `baseRef` can send open pin threads to a coding agent (Codex or Claude Code). Only files that differ from the repository are put in the task, which must fit the 64 KiB coding-task limit ([`document_too_large_for_agent`](errors/document-too-large-for-agent.md)). See [Send comment threads to a coding agent](comment-threads-and-agents.md).

## Limits

40 KB recommended and 512 KB hard per board ([`board_too_large`](errors/board-too-large.md)), 2 MiB per version ([`document_too_large`](errors/document-too-large.md)), 50 boards, and 1 MiB per MCP request (create a larger design from a repository; update it in the editor or by sending threads to its agent, since `publish_version` sends every file).

## Security

Boards are sanitised on every write and shown only in sandboxed frames that cannot run script; the design page's policy allows inline styles but never scripts. See [Security](../docs/documents.md#security).

## Related

- [Board format v1](design-boards-format.md)
- [Exporting designs and documents](document-exports.md)
- [Documents](documents.md)
- [Review and approve documents](document-review.md)
- [Send comment threads to a coding agent](comment-threads-and-agents.md)
- [Low-power mode](low-power-mode.md) (the export renderer sleeps when idle)
