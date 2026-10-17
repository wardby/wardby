---
type: invariant
title: Warm input publication must refuse replacement
description: Atomic visibility alone is insufficient when one warm worker may receive its capability only once.
tags: [native, isolation, workers]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: publish
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/native-worker/warm-delivery.ts#L19-L36
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/native-worker/warm-delivery.ts", "src/native-worker/main.ts"]
  citations:
    - id: publish
      repo: github:wardby/wardby
      path: src/native-worker/warm-delivery.ts
      lines: [19, 36]
      symbol: warmDeliveryCommand
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:cfb11a192eec28b8296f9e7d56d79dd9b70c2aae4f57ef888c7e4173e1f1219b
  confidence: high
---

Warm delivery writes stdin to an exclusive temporary file, then hard-links it to the input filename. Unlike rename, the link cannot replace an input already published by another delivery.[^publish]

**What to do:** retain both complete-file visibility and no-replacement semantics. [Native sandbox, claim isolation](../native-sandbox.md#how-claims-keep-the-isolation-guarantees) already documents single-use workers and capability delivery over stdin; this is the file-publication consequence of that contract.

[^publish]: src/native-worker/warm-delivery.ts, lines 19-36.
