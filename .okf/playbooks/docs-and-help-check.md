---
type: Playbook
title: Docs and help check for features
description: Every operator-visible change must be evaluated against docs/ and help/, and public docs must stay operator-generic.
tags: [docs, help, process, strict]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: claude-md
    resource: /CLAUDE.md
---

# Rules

These live in `CLAUDE.md`; read them there:

- § "Every feature gets a docs + help check — STRICT": which changes need a
  `docs/` update and a `help/` article, and what the PR description says.
- § "Public docs are for operators — STRICT": what stays out of tracked docs.
- § "Deployment (deploy/) — STRICT": reusable modules, nothing from live tests
  committed.

# Where

Operator guides are in `docs/` (plus `deploy/**/*.md` and `README.md`);
help articles in `help/` (error codes in `help/errors/`), bundled by
`npm run build:help` and served by the `search_help` / `get_help_article`
MCP tools ([MCP server](/architecture/mcp-server.md)).
