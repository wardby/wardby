---
id: errors/document-too-large
title: Document too large (document_too_large)
summary: A Markdown version is over 1 MiB (1,048,576 bytes), or a design version is over 2 MiB.
audience: operator
tags: [error, documents, document_too_large]
appliesTo: ">=0.10.0"
---

# Document too large

`document_too_large` (HTTP 413). A Markdown version is at most 1 MiB of UTF-8 text, and a design version at most 2 MiB in all (every file counted in bytes). `create_document`, `publish_version`, saves from the browser editor and importing a design from a repository are refused above that, and nothing is stored. A single board over 512 KB is [`board_too_large`](board-too-large.md) instead.

Split the document or design, or remove embedded data (images pasted as base64 are the usual cause). Over MCP the request body is also capped at 1 MiB, and `publish_version` sends the full file set in one request: create a larger design from a repository (`create_document` with `repository`, `path` and `baseRef`), and update it in the editor or by sending its threads to the agent. Links to images are fine. The limit counts bytes, not characters, so non-Latin text counts for more.

See [Documents](../documents.md).
