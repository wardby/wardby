---
type: overview
title: Native tool and worker isolation
description: QuickJS evaluates user tools while a run-bound gateway retains privileged effects and native worker authority.
tags: [sandbox, native, isolation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:22:57.805Z }
sources:
  - id: tool
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/sandbox/user-tool.ts#L20-L46
  - id: composition
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/native-worker/composition.ts#L30-L92
  - id: worker
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/native-worker/worker.ts#L37-L107
  - id: gateway
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/native-worker/gateway-server.ts#L147-L186
  - id: model
    url: https://github.com/wardby/wardby/blob/87d6ed5a5361fddede4703ea73452caa9bb25b12/src/native-worker/gateway-server.ts#L282-L308
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/sandbox/**", "src/native-worker/**"]
  citations:
    - id: tool
      repo: github:wardby/wardby
      path: src/sandbox/user-tool.ts
      lines: [20, 46]
      symbol: runUserToolCall
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:434c5356f9d2f11b7619a6c8aa38e652dc2425a550152ca00e7813f1764f7a0e
    - id: composition
      repo: github:wardby/wardby
      path: src/native-worker/composition.ts
      lines: [30, 92]
      symbol: buildNativeSandboxExecutor
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:efd8be98646c541fd49bb8e5881b15e9e63c6419179113cebfc9d02b7e55c725
    - id: worker
      repo: github:wardby/wardby
      path: src/native-worker/worker.ts
      lines: [37, 107]
      symbol: runNativeWorker
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:5c7e38d220017cc81c24e78ffacf0b5d3c58f04d2628e0bf6f19146f1d2d220d
    - id: gateway
      repo: github:wardby/wardby
      path: src/native-worker/gateway-server.ts
      lines: [147, 186]
      symbol: handle
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:c41c053bce9f3d41356cbd4268bc9a13ab1712010b6a8cdc07ca3273854585ca
    - id: model
      repo: github:wardby/wardby
      path: src/native-worker/gateway-server.ts
      lines: [282, 308]
      symbol: streamModel
      sha: 87d6ed5a5361fddede4703ea73452caa9bb25b12
      spanHash: sha256:d3122b8a90bb9b4345ed411b8ddc73fedb0ea9e979f069d1a2f1615ca3eb97dd
  confidence: high
---

Native isolation has two layers: user tool bodies execute in QuickJS, and sandbox-mode native agents run their turn loop in a separate worker. The same user-tool function validates arguments and evaluates tool code against an explicitly supplied privileged host.[^tool]

An isolated native run proceeds through these steps:

1. Composition selects the Docker or Kubernetes launcher and optionally wraps it with a single-use warm-worker pool.
2. The executor establishes a run-bound gateway session and delivers worker input through the launcher's isolation and delivery gates.
3. The worker drives NativeEngine with model calls and privileged tool effects represented as gateway requests. User tools stay in local QuickJS; built-ins are served remotely.
4. The gateway validates request shape, run identity and current drivability before serving operations; model calls are restricted to the run's model. Results return to [core settlement](overview-core.md), whose authoritative accounting comes from the trusted side.[^composition][^worker][^gateway][^model]

The area owns worker protocol, sandbox bridges and launch lifecycle. Session, call and warm-worker ledgers live in [Prisma](overview-prisma.md). [Provider adapters](overview-providers.md) remain on the trusted side; [deployment](overview-deploy.md) supplies the network and container boundary. [Coding workers](overview-coding.md) use a separate execution protocol.

**What to do:** preserve [warm input publication](warm-input-publication.md) and the [private/shared datastore boundary](private-datastore-shared-boundary.md) behind privileged effects. See [native sandbox](../native-sandbox.md) for configuration and isolation guarantees.

[^tool]: src/sandbox/user-tool.ts, lines 20-46.

[^composition]: src/native-worker/composition.ts, lines 30-92.

[^worker]: src/native-worker/worker.ts, lines 37-107.

[^gateway]: src/native-worker/gateway-server.ts, lines 147-186.

[^model]: src/native-worker/gateway-server.ts, lines 282-308.
