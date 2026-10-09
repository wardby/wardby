---
type: Decision
title: Clean-room reimplementation
description: Wardby is built only from behavioral specs and public docs; no other project's source, schema or migrations may be consulted or copied.
tags: [legal, provenance, strict]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: cleanroom
    resource: /CLEANROOM.md
---

# Decision

Wardby is an independent reimplementation built only from behavioral specs,
public standards and public library docs. The charter is `CLEANROOM.md` at the
repository root; read it there.

# Where it shows up

- Migrations and `prisma/schema.prisma` are hand-written
  ([database rules](/data/database-and-migrations.md)).
- Provider interfaces are designed from the spec
  ([provider seams](/architecture/provider-seams.md)).
- Contributors certify their work with a DCO sign-off (`CONTRIBUTING.md`).
