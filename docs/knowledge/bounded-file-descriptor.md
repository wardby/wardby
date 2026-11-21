---
type: invariant
title: Untrusted file bounds belong to the open descriptor
description: Checking a path before reading it leaves file substitution and growth races across worker boundaries.
tags: [coding, isolation, files]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-16T18:34:00.557Z }
sources:
  - id: read
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/coding-worker/artifact.ts#L22-L49
  - id: skills
    url: https://github.com/wardby/wardby/blob/744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be/src/coding-worker/skills.ts#L43-L54
  - id: result
    url: https://github.com/wardby/wardby/blob/8b17cbf18ad48bdcac71bf5857c4b31eab388bc9/src/providers/jobs/docker.ts#L1383-L1397
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/coding-worker/artifact.ts", "src/coding-worker/skills.ts", "src/providers/jobs/docker.ts"]
  citations:
    - id: read
      repo: github:wardby/wardby
      path: src/coding-worker/artifact.ts
      lines: [22, 49]
      symbol: readBoundedRegularFile
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:478dfd0450f68680aa36bf155d987be848f8f69ff54e2ffd94c492cb35091fe7
    - id: skills
      repo: github:wardby/wardby
      path: src/coding-worker/skills.ts
      lines: [43, 54]
      symbol: skillNameFromFile
      sha: 744d27eb926ccf7eafe52c98ac2af7f9bcd5c1be
      spanHash: sha256:022ed743f1ccb279f73e4520bf458ad28eeace035ae695853c9e5f7ee52087d4
    - id: result
      repo: github:wardby/wardby
      path: src/providers/jobs/docker.ts
      lines: [1383, 1397]
      symbol: readResultArtifact
      sha: 8b17cbf18ad48bdcac71bf5857c4b31eab388bc9
      spanHash: sha256:da6466b5dc44b1de79f473668648048b3f3ef3f82a6cce61516e8bfa76efb996
  confidence: high
---

The bounded reader opens without following a final symlink and without blocking on a FIFO, checks the opened descriptor against the path inode, and reads at most one byte beyond the limit to detect growth. Both repository skill scanning and Docker result collection use it.[^read][^skills][^result]

**What to do:** preserve descriptor checks and the bounded read together. Replacing them with a path stat followed by readFile reopens substitution and growth races even when the initial size was safe.

[^read]: src/coding-worker/artifact.ts, lines 22-49.

[^skills]: src/coding-worker/skills.ts, lines 43-54.

[^result]: src/providers/jobs/docker.ts, lines 1383-1397.
