---
id: errors/native-sandbox-isolation-mismatch
title: Native worker pod differs from what Wardby built
summary: On Kubernetes, the sandbox pod or its NetworkPolicy as stored by the cluster differs from what Wardby created, so the run failed before starting.
audience: operator
tags: [error, native-agents, sandbox, kubernetes, native_sandbox_isolation_mismatch]
appliesTo: ">=0.5.4"
---

# Native worker pod differs from what Wardby built

`native_sandbox_isolation_mismatch` means that with `NATIVE_SANDBOX_LAUNCHER=kubernetes`, Wardby read back the worker pod and NetworkPolicy it had just created and found a security-relevant difference: a service-account token, host networking, a different runtime class, priority class, image, container resources, or container security context or environment, an extra init container, or a changed NetworkPolicy. Something in the cluster modified the objects after creation, typically a mutating admission webhook, policy engine, or service mesh injector. The run is failed and the pod removed.

1. Inspect an equivalent pod while a run is starting: `kubectl get pods -n <namespace> -l wardby.io/component=native-run -o yaml`.
2. Find the admission controller that changes it (`kubectl get mutatingwebhookconfigurations`) and exempt pods labeled `wardby.io/component: native-run` and the run namespace's NetworkPolicies, for example by namespace or label selector. Do not disable sidecar-style injection by editing the pod after the fact.
3. If `NATIVE_SANDBOX_RUNTIME_CLASS` or `NATIVE_SANDBOX_PRIORITY_CLASS` is set, confirm no policy overrides it. On GKE Autopilot set `KUBERNETES_PLATFORM=gke-autopilot` so pod resources are already in the form Autopilot admits and are not rewritten.
4. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
