---
type: invariant
title: Blob absence must distinguish missing infrastructure
description: Mapping a storage outage to not_found can delete valid dependency snapshot metadata.
tags: [storage, cache, providers]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: missing
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/providers/storage/s3.ts#L26-L32
  - id: cleanup
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/coding-proxy/dependency-cache/service.ts#L298-L318
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/providers/storage/**", "src/providers/coding-proxy/dependency-cache/service.ts"]
  citations:
    - id: missing
      repo: github:wardby/wardby
      path: src/providers/storage/s3.ts
      lines: [26, 32]
      symbol: isNotFound
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:686cdad150c8c0d58e6b9acc5a2cd0bdf2e65b07b5ce8740938f43747f1408b7
    - id: cleanup
      repo: github:wardby/wardby
      path: src/providers/coding-proxy/dependency-cache/service.ts
      lines: [298, 318]
      symbol: download
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:02d4e058438d562ba55b6681e0267e890eed1ef82159a3b332d214f2fd066427
  confidence: high
---

The cache deletes snapshot metadata when getStream raises BlobStoreError with code not_found. The S3 adapter therefore maps missing keys, including the bare HeadObject NotFound response, but leaves NoSuchBucket and other failures as errors.[^missing][^cleanup]

**Why:** not_found authorizes metadata cleanup; it is not a generic unavailable response. New storage adapters must preserve this distinction so an infrastructure failure cannot masquerade as a dangling snapshot.

[^missing]: src/providers/storage/s3.ts, lines 26-32.

[^cleanup]: src/providers/coding-proxy/dependency-cache/service.ts, lines 298-318.
