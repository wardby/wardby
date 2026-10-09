---
id: errors/native-sandbox-worker-lost
title: Native worker lost
summary: The sandbox worker container disappeared and was not relaunched.
audience: operator
tags: [error, native-agents, sandbox, native_sandbox_worker_lost]
appliesTo: ">=0.5.4"
---

# Native worker lost

`native_sandbox_worker_lost` means the run's worker container (or Kubernetes pod) is gone and left no result, for example because the Docker host restarted or an operator removed the container. Wardby never relaunches a worker, because a relaunch could repeat tool side effects.

1. Check whether the Docker host or daemon restarted around the run's time.
2. List workers with `docker ps --all --filter label=io.wardby.component=native-worker`; do not remove workers of running runs by hand.
3. On Kubernetes, check whether the node was drained or preempted, and list pods with `kubectl get pods -n <namespace> -l wardby.io/component=native-run`.
4. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
