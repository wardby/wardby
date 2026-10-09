---
id: errors/native-sandbox-capacity
title: Native sandbox is at capacity
summary: A sandbox run could not start because the concurrent sandbox run limit or the namespace ResourceQuota has no room; the run failed at start and was not queued.
audience: operator
tags: [error, native-agents, sandbox, kubernetes, capacity, quota, native_sandbox_capacity]
appliesTo: ">=0.5.4"
---

# Native sandbox is at capacity

`native_sandbox_capacity` means a sandbox-mode run could not start because there was no room for it. The run failed at start; it is not queued. The message gives one of two reasons:

- **"N sandbox runs are already active (NATIVE_SANDBOX_MAX_CONCURRENT)"**: the cap on concurrent sandbox runs, counted across all server replicas as active gateway sessions, has been reached.
- **"the namespace's ResourceQuota has no room for another native worker pod"**: with `NATIVE_SANDBOX_LAUNCHER=kubernetes`, the run namespace's quota on pods, CPU, or memory is full.

1. Wait for running sandbox runs to finish, then trigger the run again.
2. To allow more at once, raise `NATIVE_SANDBOX_MAX_CONCURRENT` (unset means no cap) and raise the namespace ResourceQuota with it. Each worker pod needs its CPU and memory limits (`NATIVE_SANDBOX_CPUS`, `NATIVE_SANDBOX_MEMORY_MB`) from the quota, which coding runs and the gateway share. Idle warm-pool workers (`NATIVE_SANDBOX_WARM_POOL_SIZE`) take quota too, so leave room for `NATIVE_SANDBOX_MAX_CONCURRENT` plus the pool size.
3. Check current usage with `kubectl describe resourcequota -n <namespace>` and `kubectl get pods -n <namespace> -l wardby.io/component=native-run`.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
