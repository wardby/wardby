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

Wardby is an independent reimplementation.[^cleanroom] Permitted inputs are
private behavioral specs, public standards and RFCs, and public docs for
third-party libraries and cloud SDKs. Prohibited: any other project's source,
database schema, migrations or config.

# Consequences

1. Implement only from the spec.
2. Regenerate every artifact, including `prisma/schema.prisma` and migrations
   ([database rules](/data/database-and-migrations.md)).
3. Provider interfaces are designed from the spec
   ([provider seams](/architecture/provider-seams.md)).
4. Contributors affirm this via the DCO sign-off in `CONTRIBUTING.md`.

License is Apache-2.0.

[^cleanroom]: Clean-Room Charter
