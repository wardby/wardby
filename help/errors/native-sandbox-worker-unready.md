---
id: errors/native-sandbox-worker-unready
title: Native worker pod did not start
summary: On Kubernetes, the sandbox worker pod did not reach the Running state in time, so the run failed before starting.
audience: operator
tags: [error, native-agents, sandbox, kubernetes, native_sandbox_worker_unready]
appliesTo: ">=0.5.4"
---

# Native worker pod did not start

`native_sandbox_worker_unready` means that with `NATIVE_SANDBOX_LAUNCHER=kubernetes`, the worker pod stayed pending past the start-up limit (`NATIVE_SANDBOX_READY_TIMEOUT_MS`, default two minutes). Nothing ran.

1. Describe the pod while it waits: `kubectl describe pod -n <namespace> -l wardby.io/component=native-run`. Look at the events for image pull errors, unschedulable reasons, or an unknown runtime class.
2. Image pull: the cluster must be able to pull `NATIVE_SANDBOX_WORKER_IMAGE` (a registry digest) without interactive credentials; add a pull secret to the namespace's default service account if the registry is private.
3. Scheduling: raise node capacity or lower `NATIVE_SANDBOX_CPUS` and `NATIVE_SANDBOX_MEMORY_MB`, and check namespace ResourceQuotas.
4. Runtime class: confirm `NATIVE_SANDBOX_RUNTIME_CLASS` (or `KUBERNETES_RUNTIME_CLASS`) exists on the cluster.
5. On a cold node, such as a first gVisor pod on GKE Autopilot (about two minutes), raise `NATIVE_SANDBOX_READY_TIMEOUT_MS` (1000 to 1800000; about 600000 on Autopilot).
6. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
