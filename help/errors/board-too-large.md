---
id: errors/board-too-large
title: Board too large (board_too_large)
summary: One board file is over 512 KB.
audience: operator
tags: [error, documents, designs, board_too_large]
appliesTo: ">=0.10.0"
---

# board_too_large

`board_too_large` (HTTP 413). One board's HTML file is over 512 KB (524,288 bytes) after it was read or normalised. Nothing is stored. A board over 40 KB is accepted with a warning; 512 KB is the hard limit. The same code is returned when a board file in the repository is too large to import or to read after a coding agent's run (an agent run then ends as failed).

Split the board into several, or remove embedded data (large `data:` images are the usual cause). The whole design must also stay under 2 MiB per version (`document_too_large`).

See [Board format v1](../design-boards-format.md) and [Designs](../designs.md).
