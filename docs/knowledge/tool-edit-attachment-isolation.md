---
type: invariant
title: Tool edits must serialize with new attachments
description: Attachment checks protect another owner's capabilities only when concurrent MCP attachment participates in the same isolation contract.
tags:
  - tools
  - authorization
  - concurrency
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-19T06:04:43.490Z }
sources:
  - id: update
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/tool-admin.ts#L101-L116
  - id: attach
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/mcp/tools/tools.ts#L333-L365
  - id: isolation
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/mcp/tools/tools.ts#L398-L416
  - id: delete
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/tool-admin.ts#L126-L147
  - id: boundary
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/core/tool-admin.ts#L18-L29
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    - "src/core/tool-admin.ts"
    - "src/mcp/tools/tools.ts"
    - "src/cli.ts"
    - "src/import/create.ts"
  citations:
    - id: update
      repo: github:wardby/wardby
      path: src/core/tool-admin.ts
      lines: [101, 116]
      symbol: updateToolGuarded
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:2d9c5f799015a76250c2d04d44dee5be423e7a1b37a16149ee9b972de8d0b0c9
    - id: attach
      repo: github:wardby/wardby
      path: src/mcp/tools/tools.ts
      lines: [333, 365]
      symbol: attach_tool
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:389aa259283d29c8c2132f26d7fb5b47f00b77fb83fa26407780984dac67c58c
    - id: isolation
      repo: github:wardby/wardby
      path: src/mcp/tools/tools.ts
      lines: [398, 416]
      symbol: attach_tool transaction
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:fc54d9ba1b268c49997ef0f2df92989a14ada4ed6fa0786cd987b9e17f10625f
    - id: delete
      repo: github:wardby/wardby
      path: src/core/tool-admin.ts
      lines: [126, 147]
      symbol: deleteToolGuarded
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:9609ad535296731c083489d5743acf95638c2b5b0d748691c740c502b88687bf
    - id: boundary
      repo: github:wardby/wardby
      path: src/core/tool-admin.ts
      lines: [18, 29]
      symbol: tool administration concurrency boundary
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:de911463a4a68377c703fbddd44214de950446593a8d41c06a4893304466267b
  confidence: high
---

An attachment authorizes the tool row's current code to use the agent owner's granted capabilities. Updating that row therefore checks attachments against the tool's owner, even when the caller is an operator: administrative authority to edit the tool is not consent from another agent owner. The update refuses attachments belonging to other owners, including a public agent when the tool is privately owned.[^update]

The check and update run in one Serializable transaction. MCP attachment reads the same tool row and writes its attachment under Serializable isolation too; a concurrent attachment must conflict with the edit rather than receive newly substituted code after an earlier safety check.[^attach][^isolation] Deletion checks all attachments before detaching any; its foreign-key failure is also translated into an attachment race.[^delete]

**What to do:** preserve both transactions when changing either side. A standalone attachment check before a tool update leaves a capability substitution race. The CLI and importer attachment paths are operator-only and do not provide this same concurrency guarantee.[^boundary] [Security deployment](../security-deployment.md#sharing-agents) describes owner consent; this records the concurrency consequence. See [MCP](overview-mcp.md) and [core](overview-core.md).

[^update]: src/core/tool-admin.ts, lines 101-116.

[^attach]: src/mcp/tools/tools.ts, lines 333-365.

[^isolation]: src/mcp/tools/tools.ts, lines 398-416.

[^delete]: src/core/tool-admin.ts, lines 126-147.

[^boundary]: src/core/tool-admin.ts, lines 18-29.
