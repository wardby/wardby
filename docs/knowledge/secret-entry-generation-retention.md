---
type: invariant
title: Secret entry generations must survive result consumption
description: Consumed outcomes retain replay protection, and minting a new link extends the generation record’s lifetime.
tags:
  - mcp
  - secrets
  - replay
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-23T06:06:02.167Z }
sources:
  - id: consume
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/tools/secret-elicitation.ts#L156-L174
  - id: mint
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/tools/secret-elicitation.ts#L187-L221
  - id: reject
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/mcp/tools/secret-elicitation.ts#L264-L272
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    - "src/mcp/tools/secret-elicitation*"
    - "src/mcp/tools/secrets.ts"
  citations:
    - id: consume
      repo: github:wardby/wardby
      path: src/mcp/tools/secret-elicitation.ts
      lines: [156, 174]
      symbol: consumeSecretElicitationOutcome
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:3715d7e710707337af23fdd18daf79576f37df48de6f710e5effc4e2455e7bc6
    - id: mint
      repo: github:wardby/wardby
      path: src/mcp/tools/secret-elicitation.ts
      lines: [187, 221]
      symbol: newCreateLink / clearSecretElicitationOutcome
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:9b177a993ea6f42a42560b7da035c4f5e72a185e9f10adaa028fe4c5b1bc374a
    - id: reject
      repo: github:wardby/wardby
      path: src/mcp/tools/secret-elicitation.ts
      lines: [264, 272]
      symbol: fulfillSecretElicitation
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:32c5b90c7a30b6af39d5fda226f6026ef5240f8357317a415b4490d97018dddd
  confidence: high
---

[Secret guidance](../tool-secrets.md#changing-a-secrets-value) already describes fresh entry links and rejection of older forms. The storage consequence is that an outcome is also a generation record: consuming its result marks it consumed instead of deleting it. Deleting a secret writes a consumed marker with an incremented generation.[^consume][^mint]

Minting another link preserves the stored generation and extends the row's expiry for another elicitation lifetime. Submission compares the link's generation with the retained record; keeping only unread results would let cleanup erase the state needed to recognize an older form.[^mint][^reject]

**What to do:** preserve the generation and expiry extension when refactoring polling or cleanup. Consumed is a presentation state, not permission to remove replay protection while links can still be valid. This complements the [replica verification contract](secret-entry-replica-contract.md).

[^consume]: src/mcp/tools/secret-elicitation.ts, lines 156-174.

[^mint]: src/mcp/tools/secret-elicitation.ts, lines 187-221.

[^reject]: src/mcp/tools/secret-elicitation.ts, lines 264-272.
