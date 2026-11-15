---
id: errors/web-assets-missing
title: Page assets missing (web_assets_missing)
summary: The browser bundle was not built into this installation.
audience: operator
tags: [error, documents, web_assets_missing]
appliesTo: ">=0.10.0"
---

# Page assets missing

`web_assets_missing` (HTTP 503). The control plane could not find `dist/web-assets/manifest.json`. Official images include it. When building from source, run `npm run build` (it runs `npm run build:web`) and restart.

See [Documents](../documents.md).
