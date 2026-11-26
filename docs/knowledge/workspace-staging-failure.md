---
type: invariant
title: Failed workspace fills must remain untrusted
description: Collection failure must not expose a partially materialized worker tree to validation or trusted replacement.
tags: [coding, collection, isolation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:24:27.356Z }
sources:
  - id: swap
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/jobs/workspace-swap.ts#L20-L55
  - id: docker
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/jobs/docker.ts#L390-L426
  - id: kubernetes
    url: https://github.com/wardby/wardby/blob/1853f87cef0b4afbf5e5227635a1f1275c7ad68a/src/providers/jobs/kubernetes.ts#L981-L1010
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/providers/jobs/workspace-swap.ts", "src/providers/jobs/docker.ts", "src/providers/jobs/kubernetes.ts"]
  citations:
    - id: swap
      repo: github:wardby/wardby
      path: src/providers/jobs/workspace-swap.ts
      lines: [20, 55]
      symbol: replaceDirectoryFromStaging
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:0d7e951e15553a190b064604ec72c49998f79ebff84b8983aae37b212cc56069
    - id: docker
      repo: github:wardby/wardby
      path: src/providers/jobs/docker.ts
      lines: [390, 426]
      symbol: DockerJobLauncher.materializeWorkspace
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:49548da40452dd43841a74f0a3aa7df6e203646f661a22e09118f3ebd9ff4d33
    - id: kubernetes
      repo: github:wardby/wardby
      path: src/providers/jobs/kubernetes.ts
      lines: [981, 1010]
      symbol: KubernetesJobLauncher.materializeWorkspace
      sha: 1853f87cef0b4afbf5e5227635a1f1275c7ad68a
      spanHash: sha256:66fe0bd365254d827cc647327c6f472ccb757dd790d45af53e6e8af2cda5da8b
  confidence: high
---

Both job launchers materialize collected worker content through a sibling staging directory. Only a successful fill proceeds to validation and replacement of the trusted workspace; a rejected fill can leave escaping symlinks and must go straight to removal without walking that tree.[^swap][^docker][^kubernetes]

The swap keeps the original workspace until filling and validation succeed, then uses a backup during renames. Failure after moving the original attempts to restore it before cleanup; restoration is best effort, so this is not a crash-safe transaction.[^swap]

**What to do:** keep fill, validation and replacement in that order. Never catch a collection error and continue validating or publishing the partial tree. Preserve cleanup that unlinks symlinks rather than traversing them. This complements [descriptor-bound reads](bounded-file-descriptor.md) at the directory boundary; see [coding execution](overview-coding.md).

[^swap]: src/providers/jobs/workspace-swap.ts, lines 20-55.

[^docker]: src/providers/jobs/docker.ts, lines 390-426.

[^kubernetes]: src/providers/jobs/kubernetes.ts, lines 981-1010.
