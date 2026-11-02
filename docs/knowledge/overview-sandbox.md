---
type: overview
title: Native tool and worker isolation
description: QuickJS evaluates user tools while a run-bound gateway retains privileged effects and native worker authority.
tags: [sandbox, native, isolation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-11-02T06:04:39.135Z }
sources:
  - id: tool
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/sandbox/user-tool.ts#L20-L46
  - id: composition
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/native-worker/composition.ts#L30-L92
  - id: worker
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/native-worker/worker.ts#L36-L117
  - id: gateway
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/native-worker/gateway-server.ts#L147-L185
  - id: model
    url: https://github.com/wardby/wardby/blob/39e9de0bcf8d4b8df8f69289d580229ff375a664/src/native-worker/gateway-server.ts#L282-L306
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
      lines: [36, 117]
      symbol: runNativeWorker
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:43b0cb7ed92c170937b63bdf258ad7a5c1adceeb14c305a9ce4cda1c4f8d78f1
    - id: gateway
      repo: github:wardby/wardby
      path: src/native-worker/gateway-server.ts
      lines: [147, 185]
      symbol: handle
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:c5067a06bf3ba16e1e8285b0afc47087de5f32dd8ec84bd22f1e6d4d1f3b278d
    - id: model
      repo: github:wardby/wardby
      path: src/native-worker/gateway-server.ts
      lines: [282, 306]
      symbol: streamModel
      sha: 39e9de0bcf8d4b8df8f69289d580229ff375a664
      spanHash: sha256:e1bc656613f650211d293c3ac47ec948221284b24f335a04fd1adf68dce037dd
  confidence: high
---

Native isolation has two layers: user tool bodies execute in QuickJS, and sandbox-mode native agents run their turn loop in a separate worker. The same user-tool function validates arguments and evaluates tool code against an explicitly supplied privileged host.[^tool]

An isolated native run proceeds through these steps:

1. Composition selects the Docker or Kubernetes launcher and optionally wraps it with a single-use warm-worker pool.
2. The executor establishes a run-bound gateway session and delivers worker input through the launcher's isolation and delivery gates.
3. The worker drives NativeEngine with model calls and privileged tool effects represented as gateway requests. User tools stay in local QuickJS; long-running built-ins return pending and are polled with the same call ID so another gateway replica can resume them.
4. The gateway validates request shape, run identity, proven network readiness and current drivability before serving operations; model calls are restricted to the run's model. Results return to [core settlement](overview-core.md), whose authoritative accounting comes from the trusted side.[^composition][^worker][^gateway][^model]

The area owns worker protocol, sandbox bridges and launch lifecycle. Session, call and warm-worker ledgers live in [Prisma](overview-prisma.md). [Provider adapters](overview-providers.md) remain on the trusted side; [deployment](overview-deploy.md) supplies the network and container boundary. [Coding workers](overview-coding.md) use a separate execution protocol.

**What to do:** preserve [warm input publication](warm-input-publication.md) and the [private/shared datastore boundary](private-datastore-shared-boundary.md) behind privileged effects. See [native sandbox](../native-sandbox.md) for configuration and isolation guarantees.

[^tool]: src/sandbox/user-tool.ts, lines 20-46.

[^composition]: src/native-worker/composition.ts, lines 30-92.

[^worker]: src/native-worker/worker.ts, lines 36-117.

[^gateway]: src/native-worker/gateway-server.ts, lines 147-185.

[^model]: src/native-worker/gateway-server.ts, lines 282-306.
