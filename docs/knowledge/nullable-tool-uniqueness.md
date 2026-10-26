---
type: pitfall
title: Nullable tool ownership leaves a uniqueness gap
description: The owner-and-name unique index does not deduplicate ownerless tools in PostgreSQL.
tags: [database, tools, ownership]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: index
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/prisma/migrations/20260925030000_tool_name_per_owner/migration.sql#L1-L11
  - id: import
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/import/create.ts#L127-L143
  - id: cli
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/cli.ts#L314-L321
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["prisma/schema.prisma", "prisma/migrations/**", "src/cli.ts", "src/import/create.ts"]
  citations:
    - id: index
      repo: github:wardby/wardby
      path: prisma/migrations/20260925030000_tool_name_per_owner/migration.sql
      lines: [1, 11]
      symbol: Tool_ownerId_name_key
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:d1a29163bd0e6398e8dd99442e8c24d32490d3c85dbc671e1636bd16ac8343f5
    - id: import
      repo: github:wardby/wardby
      path: src/import/create.ts
      lines: [127, 143]
      symbol: createFromBundle
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:ad43b75b4bbf957fbf0bffa2003df56bcf120d96261ef7d322101e69f1aaa903
    - id: cli
      repo: github:wardby/wardby
      path: src/cli.ts
      lines: [314, 321]
      symbol: toolCreate
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:bec79921d22a9a3264b81b1996624bb967a79acd2884f58659650ceda1db4b08
  confidence: high
---

PostgreSQL treats NULL owners as distinct in the compound tool-name index. CLI creation explicitly checks the ownerless namespace, and the importer uses findFirst plus create rather than a nullable compound upsert.[^index][^import][^cli]

**What to do:** preserve owner-scoped lookups, and do not assume the database index arbitrates concurrent ownerless creates. A read-before-create check can still race; any stronger uniqueness guarantee needs database enforcement for the NULL-owner case. For schema changes, see [CLAUDE.md, Database / Prisma](../../CLAUDE.md#database--prisma--strict).

[^index]: prisma/migrations/20260925030000_tool_name_per_owner/migration.sql, lines 1-11.

[^import]: src/import/create.ts, lines 127-143.

[^cli]: src/cli.ts, lines 314-321.
