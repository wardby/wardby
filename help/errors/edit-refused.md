---
id: errors/edit-refused
title: Live edit refused (edit_refused)
summary: An edit would have shown one of the document agent's secret values to other people.
audience: operator
tags: [error, documents, live editing, secrets, edit_refused]
appliesTo: ">=0.10.2"
---

# Live edit refused

`edit_refused`. In live editing, every edit is checked before anyone else receives it. An edit that would put one
of the secret values of the document's agent into the text (for example, a pasted API key) is refused: no one
else receives it, nothing is saved, and the page reloads from the server's copy with a message.

Saved versions already have these values removed; the live check keeps them from reaching other people while
you type. Remove the value from what you paste, or use the secret's name instead.

See [Documents](../documents.md).
