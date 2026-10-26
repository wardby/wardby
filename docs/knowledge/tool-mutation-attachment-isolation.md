---
type: invariant
title: Tool mutations must serialize with attachments
description: Checking tool ownership alone cannot authorize replacing code already trusted by another agent owner.
tags:
  - tools
  - authorization
  - transactions
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-26T06:05:07.739Z }
sources:
  - id: update
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/core/tool-admin.ts#L100-L117
  - id: delete
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/core/tool-admin.ts#L120-L150
  - id: attach
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/mcp/tools/tools.ts#L398-L416
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    - "src/core/tool-admin.ts"
    - "src/mcp/tools/tools.ts"
    - "src/mcp/auth/ownership.ts"
    - "src/cli.ts"
  citations:
    - id: update
      repo: github:wardby/wardby
      path: src/core/tool-admin.ts
      lines: [100, 117]
      symbol: updateToolGuarded
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:7a87a047b39f6a25042bff28aa6ddca2f20078819f909ed9b83b31c26302b510
    - id: delete
      repo: github:wardby/wardby
      path: src/core/tool-admin.ts
      lines: [120, 150]
      symbol: deleteToolGuarded
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:85550cd3ea83a41b8031789a1425807d2951f74ac335fc081103f691003bf8c2
    - id: attach
      repo: github:wardby/wardby
      path: src/mcp/tools/tools.ts
      lines: [398, 416]
      symbol: attach_tool transaction
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:fc54d9ba1b268c49997ef0f2df92989a14ada4ed6fa0786cd987b9e17f10625f
  confidence: high
---

An attachment can grant tool code access to an agent owner's capabilities. Updating the tool therefore checks attached agents against the tool's owner, even when the caller is a CLI operator. Ownership authorization, attachment reads and the update share one Serializable transaction with MCP attachment writes, so a new attachment cannot slip between the guard and code replacement.[^update][^attach]

Deletion checks every attachment before detaching any of the tool owner's agents. Attachments belonging to other owners prevent the entire operation; the foreign key also rejects an attachment racing a deletion. The Serializable guarantee covers MCP attachment, while CLI and import remain trusted operator paths.[^delete]

**What to do:** route edits through the shared guarded operations and preserve attachment isolation on both sides. A tool-owner check outside the transaction cannot protect another owner's already-granted capabilities. See [MCP authorization](overview-mcp.md) and [core execution](overview-core.md).

[^update]: src/core/tool-admin.ts, lines 100-117.

[^delete]: src/core/tool-admin.ts, lines 120-150.

[^attach]: src/mcp/tools/tools.ts, lines 398-416.
