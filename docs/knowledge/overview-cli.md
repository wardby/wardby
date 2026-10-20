---
type: overview
title: CLI bootstrap and bundle import
description: Command entry points assemble local installations, invoke runtime services and reconcile imported resources.
tags: [cli, quickstart, import]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:23:52.509Z }
sources:
  - id: config
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/quickstart/index.ts#L433-L484
  - id: seed
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/quickstart/index.ts#L484-L507
  - id: import
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/import/index.ts#L72-L106
  - id: serve
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/cli.ts#L1017-L1034
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/quickstart/**", "src/import/**", "src/cli*.ts", "src/serve.ts"]
  citations:
    - id: config
      repo: github:wardby/wardby
      path: src/quickstart/index.ts
      lines: [433, 484]
      symbol: quickstartCommand
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:b37adfe4a639a53624a0ce50e771657129e6998d27f655b4f7c40d3f31aa7c8f
    - id: seed
      repo: github:wardby/wardby
      path: src/quickstart/index.ts
      lines: [484, 507]
      symbol: quickstartCommand
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:f4cf2db2dd78a46baa7b60419db278165a5784c6b1b644010e4c4784930966b2
    - id: import
      repo: github:wardby/wardby
      path: src/import/index.ts
      lines: [72, 106]
      symbol: runImport
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:5c2ae39ee543fad3e0a12717a7358556137a40f1dd6b64a7b8b962daeaf5f57d
    - id: serve
      repo: github:wardby/wardby
      path: src/cli.ts
      lines: [1017, 1034]
      symbol: serve
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:b2e4a9d5adf84699138e39a87b134e8eb8bbec07ceaf842e54ba3bcabef18116
  confidence: high
---

The CLI is the bootstrap and operations entry point around [MCP](overview-mcp.md) and [core execution](overview-core.md). Quickstart owns project-local configuration and installation state; import converts a neutral bundle into owned definitions and bindings after reconciliation.[^config][^import]

A local installation proceeds through these steps:

1. Quickstart resolves the project directory, reuses saved configuration and chooses provider settings.
2. It writes the local environment and state, starts PostgreSQL and applies migrations.
3. It can seed and run a demo, configure coding agents and connect MCP clients. Doctor and lifecycle commands operate on that saved installation.
4. Runtime commands construct the appropriate process; serve starts the combined runtime and installs shutdown handling.[^config][^seed][^serve]

An import opens the bundle, determines routable models and supported tool globals, checks existing names and capabilities, and renders a reconciliation report. Dry runs and fatal collisions return before creation; approved imports then create resources and attachments.[^import]

This area owns local state files, command orchestration and import reports. Durable resources belong to [Prisma](overview-prisma.md); [configuration](overview-config.md) establishes environment precedence, [providers](overview-providers.md) supply adapters, and [deployment assets](overview-deploy.md) supply local service topologies.

**What to do:** preserve [rename-target validation](import-rename-target.md) and [ownerless tool uniqueness checks](nullable-tool-uniqueness.md) when changing creation. See [getting started](../getting-started.md) for operator setup.

[^config]: src/quickstart/index.ts, lines 433-484.

[^seed]: src/quickstart/index.ts, lines 484-507.

[^import]: src/import/index.ts, lines 72-106.

[^serve]: src/cli.ts, lines 1017-1034.
