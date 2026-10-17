---
type: invariant
title: HTTP compatibility depends on bootstrap order
description: A Kubernetes client import can change built-in fetch behavior even when jobs use Docker.
tags: [bootstrap, http, providers]
status: stable
generated: { by: wardby-architect/gpt-6.1-sol, at: 2026-10-17T08:24:27.356Z }
sources:
  - id: compatibility
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/core/http-runtime.ts#L5-L28
  - id: install
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/core/http-runtime.ts#L92-L109
  - id: bootstrap
    url: https://github.com/wardby/wardby/blob/f4ac917fb05fd1118053462c98379c51289fed46/src/env.ts#L11-L27
wardby:
  schema: 1
  roles: [planner, builder, reviewer]
  affects: ["src/env.ts", "src/core/http-runtime.ts", "src/providers/executor/composition.ts", "src/cli.ts", "src/coding-proxy/main.ts"]
  citations:
    - id: compatibility
      repo: github:wardby/wardby
      path: src/core/http-runtime.ts
      lines: [5, 28]
      symbol: HTTP dispatcher compatibility
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:de45288094aaa10edabef6a2d28ee308536acda9d0a4b9cedb84794c6b4ee72d
    - id: install
      repo: github:wardby/wardby
      path: src/core/http-runtime.ts
      lines: [92, 109]
      symbol: installHttpRuntime
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:9799d701991e03e908d4a357cad85121fe8bcd147259d03be6e1c95345a0471c
    - id: bootstrap
      repo: github:wardby/wardby
      path: src/env.ts
      lines: [11, 27]
      symbol: bootstrap imports
      sha: f4ac917fb05fd1118053462c98379c51289fed46
      spanHash: sha256:71c46404eb01aceb2d30a7617bff1df60437a1ded819b7016fd9d8bc08a08363
  confidence: high
---

Importing the Kubernetes client loads a different Undici generation, whose compatibility dispatcher can expose HTTP/2 headers in a shape Node's built-in fetch does not understand. The result is loss of response headers, affecting decompression and redirects across unrelated adapters. Executor composition imports that client even outside Kubernetes deployments.[^compatibility]

The shared environment bootstrap installs an HTTP/1-only dispatcher before other runtime work. Its installed marker makes repeated calls a no-op; it does not continuously enforce which dispatcher remains installed.[^install][^bootstrap]

**What to do:** keep the environment import first in runtime entry points and do not replace the global dispatcher later without preserving compatibility. Keep this bootstrap in the control-plane dependency tree; isolated coding-worker images have their own dependencies. See [configuration](overview-config.md) for the startup flow.

[^compatibility]: src/core/http-runtime.ts, lines 5-28.

[^install]: src/core/http-runtime.ts, lines 92-109.

[^bootstrap]: src/env.ts, lines 11-27.
