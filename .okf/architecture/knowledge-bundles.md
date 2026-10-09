---
type: Architecture Pattern
title: Repository knowledge bundles
description: Wardby's own OKF-based per-repo architecture knowledge feature, with a wardby front-matter block and span-hash citations.
tags: [knowledge, okf]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: knowledge-doc
    resource: /docs/knowledge.md
  - id: concept-ts
    resource: /src/knowledge/concept.ts
---

# Not this bundle

This `.okf/` bundle documents wardby itself. The *product feature* described
here is a separate thing: a bundle that operators keep in their own repos
(default `docs/knowledge`).[^knowledge-doc] Coding runs receive its index and
reviewers can use it.

# Format

OKF v0.2 plus a `wardby:` block (`schema: 1`, `roles`, `affects` globs,
`citations`, `supersedes`, `confidence`).[^concept-ts] A citation pins repo,
path, optional lines or symbol, a full 40-hex `sha` and a `spanHash`
(`sha256:...`) so drift can be detected by a validate command
(`src/knowledge/check.ts`, `span-hash.ts`).

[^knowledge-doc]: Architecture knowledge bundles guide
[^concept-ts]: src/knowledge/concept.ts
