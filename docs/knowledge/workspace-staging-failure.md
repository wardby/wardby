---
type: invariant
title: Failed workspace fills must remain untrusted
description: Collection failure must not expose a partially materialized worker tree to validation or trusted replacement.
tags: [coding, collection, isolation]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:24:27.356Z }
sources:
  - id: swap
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/providers/jobs/workspace-swap.ts#L16-L51
  - id: docker
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/providers/jobs/docker.ts#L385-L400
  - id: kubernetes
    url: https://github.com/wardby/wardby/blob/dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c/src/providers/jobs/kubernetes.ts#L796-L808
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/providers/jobs/workspace-swap.ts", "src/providers/jobs/docker.ts", "src/providers/jobs/kubernetes.ts"]
  citations:
    - id: swap
      repo: github:wardby/wardby
      path: src/providers/jobs/workspace-swap.ts
      lines: [16, 51]
      symbol: replaceDirectoryFromStaging
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:0d7e951e15553a190b064604ec72c49998f79ebff84b8983aae37b212cc56069
    - id: docker
      repo: github:wardby/wardby
      path: src/providers/jobs/docker.ts
      lines: [385, 400]
      symbol: DockerJobLauncher.materializeWorkspace
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:3e9525156cbd3c0791e79ff7ce86b16c92b0d62d8acc92a104b604fc6f54c08f
    - id: kubernetes
      repo: github:wardby/wardby
      path: src/providers/jobs/kubernetes.ts
      lines: [796, 808]
      symbol: KubernetesJobLauncher.materializeWorkspace
      sha: dbcd5fd693b7b5891ed6c8897b30a5bc1ce6404c
      spanHash: sha256:44a85cadf23fdb1d77c0f4e1738873327756c029ce114c4efb47276d18abac84
  confidence: high
---

Both job launchers materialize collected worker content through a sibling staging directory. Only a successful fill proceeds to validation and replacement of the trusted workspace; a rejected fill can leave escaping symlinks and must go straight to removal without walking that tree.[^swap][^docker][^kubernetes]

The swap keeps the original workspace until filling and validation succeed, then uses a backup during renames. Failure after moving the original attempts to restore it before cleanup; restoration is best effort, so this is not a crash-safe transaction.[^swap]

**What to do:** keep fill, validation and replacement in that order. Never catch a collection error and continue validating or publishing the partial tree. Preserve cleanup that unlinks symlinks rather than traversing them. This complements [descriptor-bound reads](bounded-file-descriptor.md) at the directory boundary; see [coding execution](overview-coding.md).

[^swap]: src/providers/jobs/workspace-swap.ts, lines 16-51.

[^docker]: src/providers/jobs/docker.ts, lines 385-400.

[^kubernetes]: src/providers/jobs/kubernetes.ts, lines 796-808.
