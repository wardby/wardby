---
type: invariant
title: Viewer notifications must not abort authoritative writes
description: The viewer trigger contains notification errors so event delivery cannot fail run persistence.
tags: [database, viewer, observability]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: notify
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/prisma/migrations/20261003030000_viewer_notify_fixes/migration.sql#L1-L47
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["prisma/migrations/**", "src/viewer/**"]
  citations:
    - id: notify
      repo: github:wardby/wardby
      path: prisma/migrations/20261003030000_viewer_notify_fixes/migration.sql
      lines: [1, 47]
      symbol: wardby_viewer_notify
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:8c16b83ca66d420cd0ccc5824e496625baa8ebc6b1010a0721e4ac36d6419b93
  confidence: high
---

The trigger formats the already-UTC timestamp without time-zone conversion and catches errors around pg_notify, including oversized payload failures. Its notification is a projection of the write, not a prerequisite for it.[^notify]

**What to do:** preserve the exception boundary when changing event payloads. [Viewer API](../viewer-api.md) already documents resynchronizing after stream gaps; this concept records the database consequence: viewer delivery must never roll back the write it observes.

[^notify]: prisma/migrations/20261003030000_viewer_notify_fixes/migration.sql, lines 1-47.
