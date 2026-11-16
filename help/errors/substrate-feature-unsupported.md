---
id: errors/substrate-feature-unsupported
title: The Substrate launcher does not support this run (substrate_feature_unsupported)
summary: A coding run needs coding services, which the experimental Substrate launcher does not support; use the Docker or Kubernetes launcher.
audience: operator
tags: [error, substrate, substrate_feature_unsupported, job launcher, coding-agents, services]
appliesTo: ">=0.9.15"
---

# The Substrate launcher does not support this run

`substrate_feature_unsupported` means the run asked for something the
experimental Substrate launcher cannot do. The run fails at launch, before any
actor is created. The control plane log names the feature (`services`).

| Trigger                                                                     | Feature    |
| --------------------------------------------------------------------------- | ---------- |
| A repository with `.wardby/services.yaml` and an agent that allows services | `services` |

What to do:

1. Run these agents on a deployment that uses `JOB_LAUNCHER=kubernetes` or
   `docker`, which support coding services; or
2. remove the trigger: use an agent that allows no services.

Older runs may show `substrate_feature_unsupported:workerImage`: custom images
are supported now; run it again.

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md#what-is-not-supported).
