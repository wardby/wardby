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

# Steps

1. Update the owning guide in `docs/` (also `deploy/**/*.md`, `README.md`
   where relevant), including env-var and role tables.
2. Add or update a `help/` article (frontmatter: `id`, `title`, `summary`,
   `audience`, `tags`, `appliesTo`), link related articles, run
   `npm run build:help`, and check `search_help` finds it. New error codes
   use `help/errors/`.
3. The PR description says what was added to each surface, or why none.[^claude-md]

# Operator-only rule

Tracked docs are written for people running wardby on their own
infrastructure. Keep out our test runs, our own repos and instances, internal
specs and plans (use git-ignored `docs/private/`), and PR-history narrative.

# Deployment modules

`deploy/gcp`, `deploy/aws` and the others are reusable Terraform modules: no
project ids, domains or credentials hardcoded, and never commit real
`*.tfvars`, state or outputs from live tests.

[^claude-md]: Project CLAUDE.md
