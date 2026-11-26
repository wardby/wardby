---
type: overview
title: Native tool and worker isolation
description: QuickJS evaluates user tools while a run-bound gateway retains privileged effects and native worker authority.
tags: [sandbox, native, isolation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-23T06:06:02.167Z }
sources:
  - id: tool
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/sandbox/user-tool.ts#L27-L61
  - id: composition
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/native-worker/composition.ts#L42-L136
  - id: worker
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/native-worker/worker.ts#L37-L122
  - id: gateway
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/native-worker/gateway-server.ts#L235-L263
  - id: model
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/native-worker/gateway-server.ts#L369-L396
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
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:dc6fb8fa98e5a110f9259449eb2e35f97c55e60029b24c4852a4f7930be34ef7
    - id: composition
      repo: github:wardby/wardby
      path: src/native-worker/composition.ts
      lines: [42, 136]
      symbol: buildNativeSandboxExecutor
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:210a46e0cac8abdc32678ddd9f4f9f49df715f560e797a3221510aabb93d0a7a
    - id: worker
      repo: github:wardby/wardby
      path: src/native-worker/worker.ts
      lines: [37, 122]
      symbol: runNativeWorker
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:20e3b8e17863b5b0a769ce48c2d1c25070dc34059ed8577689087d6b0032011b
    - id: gateway
      repo: github:wardby/wardby
      path: src/native-worker/gateway-server.ts
      lines: [235, 263]
      symbol: handle
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:fca2abbfdf6b0d355dbe04c098381a687d5c141a190d5c2859d5bab10e7b815f
    - id: model
      repo: github:wardby/wardby
      path: src/native-worker/gateway-server.ts
      lines: [369, 396]
      symbol: streamModel
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:7a59b6675e59a90fc1577addc0665e19a7ff241fd49b0d55b4d892fec856de46
  confidence: high
---

Native isolation has two layers: user tool bodies execute in QuickJS, and sandbox-mode native agents run their turn loop in a separate worker. The same user-tool function validates arguments and evaluates tool code against an explicitly supplied privileged host.[^tool]

An isolated native run proceeds through these steps:

1. Composition selects the Docker, Kubernetes or Substrate launcher and optionally wraps it with a single-use warm-worker pool.
2. The executor establishes a run-bound gateway session and delivers worker input through the launcher's isolation and delivery gates.
3. The worker drives NativeEngine with model calls and privileged tool effects represented as gateway requests. User tools stay in local QuickJS; built-ins are served remotely, and a pending built-in is polled with the same call ID.
4. The gateway validates request shape, run identity, proven network isolation and current drivability before serving operations; model calls are restricted to the run's model. Results return to [core settlement](overview-core.md), whose authoritative accounting comes from the trusted side.[^composition][^worker][^gateway][^model]

The area owns worker protocol, sandbox bridges and launch lifecycle. Session, call and warm-worker ledgers live in [Prisma](overview-prisma.md). [Provider adapters](overview-providers.md) remain on the trusted side; [deployment](overview-deploy.md) supplies the network and container boundary. [Coding workers](overview-coding.md) use a separate execution protocol.

**What to do:** preserve [warm input publication](warm-input-publication.md) and the [private/shared datastore boundary](private-datastore-shared-boundary.md) behind privileged effects. See [native sandbox](../native-sandbox.md) for configuration and isolation guarantees.

[^tool]: src/sandbox/user-tool.ts, lines 27-61.

[^composition]: src/native-worker/composition.ts, lines 42-136.

[^worker]: src/native-worker/worker.ts, lines 37-122.

[^gateway]: src/native-worker/gateway-server.ts, lines 235-263.

[^model]: src/native-worker/gateway-server.ts, lines 369-396.
