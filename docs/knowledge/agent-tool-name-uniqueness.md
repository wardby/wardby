---
type: invariant
title: Tool names must be unique within each agent
description: Owner-scoped tool uniqueness cannot prevent two attached tools from shadowing each other at runtime.
tags:
  - tools
  - identity
  - transactions
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-26T06:05:07.739Z }
sources:
  - id: attach
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/mcp/tools/tools.ts#L367-L383
  - id: isolation
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/mcp/tools/tools.ts#L398-L416
  - id: load
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/core/runner.ts#L805-L819
  - id: import
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/import/create.ts#L230-L246
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects:
    - "src/mcp/tools/tools.ts"
    - "src/core/tool-names.ts"
    - "src/core/runner.ts"
    - "src/import/create.ts"
    - "src/cli.ts"
  citations:
    - id: attach
      repo: github:wardby/wardby
      path: src/mcp/tools/tools.ts
      lines: [367, 383]
      symbol: registerToolAuthoringTools / attach_tool
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:27c109eb4a79b06c2f1cd5df5aa8457efb860ce8fad15cae1e9f3492a9c58e40
    - id: isolation
      repo: github:wardby/wardby
      path: src/mcp/tools/tools.ts
      lines: [398, 416]
      symbol: attach_tool transaction
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:fc54d9ba1b268c49997ef0f2df92989a14ada4ed6fa0786cd987b9e17f10625f
    - id: load
      repo: github:wardby/wardby
      path: src/core/runner.ts
      lines: [805, 819]
      symbol: loadNativeRun
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:0e3698dbde9862d290233f192c85385c8e99145a3f441df74adc0a870bbbc79f
    - id: import
      repo: github:wardby/wardby
      path: src/import/create.ts
      lines: [230, 246]
      symbol: createFromBundle
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:abb80382aec1e6721ab7a115c9fae9075708362b4b27a9fd2620971243bf2122
  confidence: high
---

Tool identity in storage is an ID, with names unique only within an owner. Execution resolves tools by name, so attaching an owner's tool and a public tool with the same name would make one shadow the other. MCP checks the attached-name namespace inside its Serializable attachment transaction; the runner independently rejects duplicates before execution.[^attach][^isolation][^load]

CLI and import are trusted operator paths, but their check-then-write does not provide the same concurrency guarantee; the importer explicitly relies on the load-time duplicate check as a backstop.[^import]

**What to do:** preserve both transactional attachment validation and load-time rejection. A unique owner/name index or unique agent/tool-ID pair cannot enforce this namespace. See [MCP](overview-mcp.md), [core](overview-core.md) and [CLI import](overview-cli.md).

[^attach]: src/mcp/tools/tools.ts, lines 367-383.

[^isolation]: src/mcp/tools/tools.ts, lines 398-416.

[^load]: src/core/runner.ts, lines 805-819.

[^import]: src/import/create.ts, lines 230-246.
