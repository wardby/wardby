---
type: invariant
title: Transcript signatures do not confer transport authority
description: Shared signing keys must not let a stdio operator link authorize a download through HTTP.
tags:
  - mcp
  - transcripts
  - authorization
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-09T06:04:39.000Z }
sources:
  - id: mint
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/tools/run-transcript.ts#L66-L75
  - id: audience
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/tools/run-transcript-download.ts#L84-L128
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    - "src/mcp/tools/run-transcript.ts"
    - "src/mcp/tools/run-transcript-download.ts"
    - "src/mcp/transport/**"
  citations:
    - id: mint
      repo: github:wardby/wardby
      path: src/mcp/tools/run-transcript.ts
      lines: [66, 75]
      symbol: registerRunTranscriptTool payload
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:073d4893362ffee4a8c1c46ba66678748fe0ce2944e142616136cce561cca6f3
    - id: audience
      repo: github:wardby/wardby
      path: src/mcp/tools/run-transcript-download.ts
      lines: [84, 128]
      symbol: isPayload / handleRunTranscriptDownload
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:0637d50712261c22f0d9ef473c04d9b5062caac614a2581b5a9aefea94d3daeb
  confidence: high
---

Transcript links use the same request-state codec as secret entry, so configuring a shared signing key can make a signature verifiable by both transports. Signature validity therefore cannot establish which transport may honor the authority in the payload.[^mint][^audience]

Minting records the serving audience and includes operator authority only for stdio. Download validation rejects an HTTP payload carrying any operator field, checks the payload audience against the serving host, then checks current run visibility for the named principal. A valid stdio signature must still fail on the HTTP route.[^mint][^audience]

**What to do:** preserve audience and operator checks independently of signature verification when sharing keys or consolidating download handlers. See [secret-entry replica keys](secret-entry-replica-contract.md), [MCP management](overview-mcp.md) and [local resume guidance](../../help/resume-runs-locally.md).

[^mint]: src/mcp/tools/run-transcript.ts, lines 66-75.

[^audience]: src/mcp/tools/run-transcript-download.ts, lines 84-128.
