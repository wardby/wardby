---
type: decision
title: MCP schemas cross the SDK boundary as JSON
description: Using the SDK schema converter avoids incompatible Zod instances at tool registration.
tags: [mcp, schemas, providers]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-15T11:18:44.473Z }
sources:
  - id: schema
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/server.ts#L64-L74
  - id: registration
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/mcp/server.ts#L282-L289
wardby:
  schema: 1
  roles: [builder, reviewer]
  affects: ["src/mcp/server.ts", "src/mcp/tools/**"]
  citations:
    - id: schema
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [64, 74]
      symbol: ToolSpec
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:bac668c827f34c5a3c952226092c734f54e2c50d0f66ac55a3c15a369b4cfb1b
    - id: registration
      repo: github:wardby/wardby
      path: src/mcp/server.ts
      lines: [282, 289]
      symbol: factory
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:6d9cdfe4089e7c9f1be23fb35e8a348407bfc70a2dd611d04875f32ef287f0d3
  confidence: high
---

The SDK bundles its own Zod module instance, so matching the package version does not make application Zod shapes compatible with its registration overload. Tool specs carry JSON Schema and registration converts it with the SDK’s own `fromJsonSchema`.[^schema][^registration]

**What to do:** keep schemas crossing this seam as plain JSON; replacing the converter with an application Zod shape can break registration even without a version mismatch.

[^schema]: src/mcp/server.ts, lines 64-74.

[^registration]: src/mcp/server.ts, lines 282-289.
