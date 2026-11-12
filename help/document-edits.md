---
id: document-edits
title: Document edits - version history, inline changes and restore
summary: The Edits tray lists a document's versions with who made them and how, shows each version's changes inline, and restores an earlier version as a new one; list_document_versions and restore_document_version do the same over MCP.
audience: operator
tags: [documents, edits, versions, history, diff, restore, list_document_versions, restore_document_version]
appliesTo: ">=0.10.0"
---

# Document edits and restore

## The Edits tray

The side panel of a document page has a **Comments** tab and an **Edits** tab. Edits lists every version, newest first: who made it, how and when.

- Editor saves by the same person, each within 5 minutes of the one before, share one row ("v4–v5 · Name · 2 edits").
- An agent's version reads "Agent · via <the person who sent the threads>", with "for thread #N" links that open those threads in the Comments tab.
- Two people with the same display name never share a row.
- Versions published over MCP are marked "(MCP)"; restores read "Restored v<N> · Name". These always have their own row.

Click a row to see that version read-only, with its changes against the version before the row: added text highlighted, removed text struck through where it was. Changes are compared word by word on the text, so a new heading or list item shows as added text, and formatting-only changes are not marked. **Back to latest** or Esc returns to the editor. New versions keep arriving in the list while you look.

## Restore

**Restore this version** (members with `write` access) asks for confirmation, then publishes that version's Markdown as a new version with the summary "Restored v<N>". Nothing is deleted, so restoring again undoes it. It runs the same checks as any publish (size limit, secret redaction, comment re-anchoring) and is refused with `document_version_conflict` when someone published after the newest version your page shows, and with `document_version_is_latest` when you pick the newest version itself. Documents that open comment-only (images, checklists or HTML) can still be restored. Readers and share-link guests see the tray and the changes, but no Restore.

## Over MCP

- `list_document_versions` (`documents:read`): `documentId`, optional `limit` (default 50, at most 200) and `before` (the `nextBefore` it returned, for older versions). It returns numbers, `via`, times, the run id and the threads the run answered; names and summaries are in `versionsText`, wrapped as untrusted tool output. It never returns content.
- `get_document` with `versionNumber` reads one version's Markdown.
- `restore_document_version` (`documents:write`): `documentId`, `versionNumber` and a required `baseNumber` (the latest version you saw) for the conflict check. `publish_version` (`documents:write`) refuses a summary that reads "Restored v<N>" (`document_summary_invalid`): only a restore writes it.

An unknown version number answers [`document_version_not_found`](errors/document-version-not-found.md).

## Related

- [Documents](documents.md)
- [Edits and restore in the full guide](../docs/documents.md#edits-and-restore)
