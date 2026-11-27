---
id: errors/edit-refused
title: Live edit refused (edit_refused)
summary: A live edit would have shown one of the document agent's secret values to other people, broken a design's board format, or made a board larger than 512 KB.
audience: operator
tags: [error, documents, designs, live editing, secrets, board format, edit_refused]
appliesTo: ">=0.10.2"
---

# Live edit refused

`edit_refused`. In live editing, every edit is checked before anyone else receives it. An edit that would put one
of the secret values of the document's agent into the text (for example, a pasted API key) is refused: no one
else receives it, nothing is saved, and the page reloads from the server's copy with a message.

On a design, an edit is also refused when it would break the [board format](../design-boards-format.md) (for example a script, an event handler or an external image) or make a board larger than 512 KB. The page reloads and says which.

An edit that changes the server's own record in the shared document (its history id, who edited last, or which page builds a board) is refused the same way: pages never write those.

Saved versions already have these values removed; the live check keeps them from reaching other people while
you type. Remove the value from what you paste, or use the secret's name instead.

See [Live editing](../live-editing.md) and [Documents](../documents.md).
