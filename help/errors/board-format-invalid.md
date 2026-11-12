---
id: errors/board-format-invalid
title: Design does not follow the board format (board_format_invalid)
summary: A design's files break one of the board format v1 rules.
audience: operator
tags: [error, documents, designs, board_format_invalid]
appliesTo: ">=0.10.0"
---

# board_format_invalid

`board_format_invalid` (HTTP 400). The files of a design (from `create_document`, `publish_version`, an editor save, a restore or a coding agent's result) break a [board format v1](../design-boards-format.md) rule, so nothing was stored.

The message lists up to 50 problems. Each names the board id and the kind of problem, for example `board cart: external reference in img src`, `board payment: file is missing`, `manifest.json: board id cart is listed twice` or `manifest.json is missing`. It never repeats the offending URL, path or file text, so it is safe to show and log. Fix every problem listed and publish again.

Common causes: an image, font or stylesheet loaded from an `https://` URL (embed it as a `data:` image, inline SVG or CSS instead), a `manifest.json` entry whose `file` is not `boards/<id>.html`, a board listed but not supplied (or supplied but not listed), a malformed CSS string, and non-text files. Scripts, `on*` attributes and `javascript:` links do not cause this error: they are removed and reported as warnings.

See [Board format v1](../design-boards-format.md) and [Designs](../designs.md).
