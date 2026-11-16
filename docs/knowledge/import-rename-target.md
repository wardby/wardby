---
type: invariant
title: Import rename targets must be checked before creation
description: Renaming a colliding entity onto another existing name would silently adopt that entity through idempotent creation.
tags: [import, ownership, identity]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: rename
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/import/preflight.ts#L38-L61
  - id: abort
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/import/index.ts#L98-L106
  - id: upsert
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/import/create.ts#L172-L199
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/import/**"]
  citations:
    - id: rename
      repo: github:wardby/wardby
      path: src/import/preflight.ts
      lines: [38, 61]
      symbol: resolveCollision
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:c9d7a0099b2a8da51423969af1f92d314287f0ae32fb708ebec731b2796fbee5
    - id: abort
      repo: github:wardby/wardby
      path: src/import/index.ts
      lines: [98, 106]
      symbol: runImport
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:e7463bf861fefd8157eaa21c951c8f635fe2b41d25f80e4d77c500eae82021a4
    - id: upsert
      repo: github:wardby/wardby
      path: src/import/create.ts
      lines: [172, 199]
      symbol: createFromBundle
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:facc284dc95ab2312bba3cd9c1f9e12203bcfdadc433f292324eeaa5e3d80ca1
  confidence: high
---

Preflight treats an occupied prefixed rename target as fatal even under the rename policy. The orchestrator returns before creation on fatal collisions; creation later upserts agents with an empty update branch.[^rename][^abort][^upsert]

**Why:** a free-looking rename that lands on an existing name can return the existing agent without changing it, after which import attachments would target that identity. Preserve target validation before idempotent creation; it is an identity boundary, not just nicer collision reporting.

[^rename]: src/import/preflight.ts, lines 38-61.

[^abort]: src/import/index.ts, lines 98-106.

[^upsert]: src/import/create.ts, lines 172-199.
