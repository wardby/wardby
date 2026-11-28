---
id: design-boards-format
title: Design board format v1 - the rules agents and people follow
summary: The seven rules a design's manifest and board HTML files must follow, a manifest example, and a copy-ready skill for repositories that want coding agents to follow the format.
audience: operator
tags: [designs, boards, board format, manifest, design-boards, skill, board_format_invalid, create_document]
appliesTo: ">=0.10.0"
---

# Design board format v1

A [design](designs.md) is stored as plain files: a `manifest.json`, one HTML file per board under `boards/`, and an optional `brand.md` (notes on tone, colours and fonts, up to 64 KB, that an agent may read). Wardby checks the files when a design is created, published, saved in the editor, restored or returned by a coding agent. Files that break a rule are refused with [`board_format_invalid`](errors/board-format-invalid.md); a board over the size limit with [`board_too_large`](errors/board-too-large.md).

## The rules

1. Files: `manifest.json` (`title`, `boards: [{ id, name, file, width }]`, the first board is the start screen) and `boards/<id>.html`; `id` is lowercase letters, digits and `-`, and `file` is `boards/<id>.html`.
2. No JavaScript: no `<script>`, no `on*=` attributes, no `javascript:` URLs.
3. All CSS in the file. No external stylesheets, images, fonts or scripts; system fonts; pictures as CSS, emoji, inline SVG or `data:` images.
4. Responsive: designed at 1280 px wide and must work at 768 and 390 (stack columns, `flex-wrap`, `grid auto-fit/minmax`, media queries).
5. Links between boards use `href="#board:<id>"`. Every board shows the same header/navigation; the logo links to the first board. Other links may use `https://` or `#`.
6. CSS variables on `body`, not `:root`; longhand properties when a value uses `var()` (`background-color`, `border-color`, not `background: var(--x)` or `border: 2px solid var(--x)`).
7. Under 40 KB per board (512 KB is the hard limit).

Wardby sends these same rules to a coding agent in every design task, and to a native agent in the `doc_create` and `doc_publish_version` tool descriptions, so an agent needs no extra setup. A repository that also wants agents to follow them outside Wardby tasks can add the skill below.

## What is removed and what is refused

Scripts, `on*` attributes, `javascript:` links and elements that load other content (frames, forms, media, `<link>`, `<meta>`) are removed when the design is stored, and the version lists a warning saying how many. External references are refused instead: a stylesheet, image, font or `url()` that is not a `data:` image or a `#fragment`. A link to an `https://` page is fine. Details and the reasons are in [Documents and designs](../docs/documents.md#security).

## Manifest example

```json
{
  "title": "Checkout flow",
  "boards": [
    { "id": "cart", "name": "Cart", "file": "boards/cart.html", "width": 1280 },
    { "id": "payment", "name": "Payment", "file": "boards/payment.html", "width": 1280 }
  ]
}
```

- `title`: 1 to 200 characters.
- `boards`: 1 to 50 entries; the first is the start screen of Play. `id` is lowercase letters, digits and `-` and must be unique. `name` is 1 to 80 characters. `file` must be exactly `boards/<id>.html`. `width` is the design width in pixels (320 to 2560, default 1280).
- Every file must be listed (`brand.md` aside). A file the manifest does not list is a format problem.

A link from the cart to the payment board is `<a href="#board:payment">Pay</a>`. In Play and in the prototype export it moves between boards.

## Limits

A board is recommended to stay under 40 KB (a larger one gets a warning) and must stay under 512 KB. A design version is at most 2 MiB in all. The MCP request body is at most 1 MiB, so publish a larger design from the repository (`create_document` with `repository`, `path` and `baseRef`) or the editor.

## A skill for repositories

Save this as `.claude/skills/design-boards/SKILL.md` (or the equivalent for your coding agent) in a repository that holds a design:

```markdown
---
name: design-boards
description: Write or edit design boards (manifest.json and boards/*.html) so Wardby accepts them. Use when creating or changing a design's HTML screens.
---

# Design boards

A design is `manifest.json` plus one HTML file per board under `boards/`. Follow these rules for every board:

1. Files: `manifest.json` (`title`, `boards: [{ id, name, file, width }]`, the first board is the start screen) and `boards/<id>.html`; `id` is lowercase letters, digits and `-`, and `file` is `boards/<id>.html`.
2. No JavaScript: no `<script>`, no `on*=` attributes, no `javascript:` URLs.
3. All CSS in the file. No external stylesheets, images, fonts or scripts; system fonts; pictures as CSS, emoji, inline SVG or `data:` images.
4. Responsive: designed at 1280 px wide and must work at 768 and 390 (stack columns, `flex-wrap`, `grid auto-fit/minmax`, media queries).
5. Links between boards use `href="#board:<id>"`. Every board shows the same header/navigation; the logo links to the first board. Other links may use `https://` or `#`.
6. CSS variables on `body`, not `:root`; longhand properties when a value uses `var()` (`background-color`, `border-color`, not `background: var(--x)` or `border: 2px solid var(--x)`).
7. Under 40 KB per board (512 KB is the hard limit).
```

## Related

- [Designs](designs.md)
- [Exporting designs and documents](document-exports.md)
- [Documents and designs guide](../docs/documents.md)
