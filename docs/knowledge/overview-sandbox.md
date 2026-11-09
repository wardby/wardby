---
type: overview
title: Native tool and worker isolation
description: QuickJS evaluates user tools while a run-bound gateway retains privileged effects and native worker authority.
tags: [sandbox, native, isolation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-09T06:04:39.000Z }
sources:
  - id: tool
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/sandbox/user-tool.ts#L27-L61
  - id: composition
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/native-worker/composition.ts#L30-L92
  - id: worker
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/native-worker/worker.ts#L35-L108
  - id: gateway
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/native-worker/gateway-server.ts#L154-L191
  - id: model
    url: https://github.com/wardby/wardby/blob/652e97f52f1f343b1bfa336f5acbbd6356e1c8c7/src/native-worker/gateway-server.ts#L297-L322
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/sandbox/**", "src/native-worker/**"]
  citations:
    - id: tool
      repo: github:wardby/wardby
      path: src/sandbox/user-tool.ts
      lines: [27, 61]
      symbol: runUserToolCall
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:dc6fb8fa98e5a110f9259449eb2e35f97c55e60029b24c4852a4f7930be34ef7
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
      lines: [35, 108]
      symbol: runNativeWorker
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:4d9870066029ba12baa4d54d7365807783bd80f1563752629119fdc7ccb9f267
    - id: gateway
      repo: github:wardby/wardby
      path: src/native-worker/gateway-server.ts
      lines: [154, 191]
      symbol: handle
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:fd67fa4989134bd4975e4ee340f93966f41d7b433f12d6ddd16942524cbcf970
    - id: model
      repo: github:wardby/wardby
      path: src/native-worker/gateway-server.ts
      lines: [297, 322]
      symbol: streamModel
      sha: 652e97f52f1f343b1bfa336f5acbbd6356e1c8c7
      spanHash: sha256:96f9b8db4ac4b471c9671663886c66331228f26d880286b39c66c3461aab1404
  confidence: high
---

Native isolation has two layers: user tool bodies execute in QuickJS, and sandbox-mode native agents run their turn loop in a separate worker. The same user-tool function validates arguments and evaluates tool code against an explicitly supplied privileged host.[^tool]

An isolated native run proceeds through these steps:

1. Composition selects the Docker or Kubernetes launcher and optionally wraps it with a single-use warm-worker pool.
2. The executor establishes a run-bound gateway session and delivers worker input through the launcher's isolation and delivery gates.
3. The worker drives NativeEngine with model calls and privileged tool effects represented as gateway requests. User tools stay in local QuickJS; built-ins are served remotely. A long-running built-in can return pending, and the worker polls with the same call ID so another gateway replica can resume it.
4. The gateway validates request shape, run identity and current drivability before serving operations; model calls are restricted to the run's model. Results return to [core settlement](overview-core.md), whose authoritative accounting comes from the trusted side.[^composition][^worker][^gateway][^model]

The area owns worker protocol, sandbox bridges and launch lifecycle. Session, call and warm-worker ledgers live in [Prisma](overview-prisma.md). [Provider adapters](overview-providers.md) remain on the trusted side; [deployment](overview-deploy.md) supplies the network and container boundary. [Coding workers](overview-coding.md) use a separate execution protocol.

**What to do:** preserve [warm input publication](warm-input-publication.md) and the [private/shared datastore boundary](private-datastore-shared-boundary.md) behind privileged effects. See [native sandbox](../native-sandbox.md) for configuration and isolation guarantees.

[^tool]: src/sandbox/user-tool.ts, lines 27-61.

[^composition]: src/native-worker/composition.ts, lines 30-92.

[^worker]: src/native-worker/worker.ts, lines 35-108.

[^gateway]: src/native-worker/gateway-server.ts, lines 154-191.

[^model]: src/native-worker/gateway-server.ts, lines 297-322.
