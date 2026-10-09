---
id: errors/native-sandbox-network-unenforced
title: Native worker network isolation not proven
summary: On Kubernetes, Wardby could not prove a sandbox pod's network isolation in time, so it removed the pod and failed the run.
audience: operator
tags: [error, native-agents, sandbox, kubernetes, native_sandbox_network_unenforced]
appliesTo: ">=0.5.4"
---

# Native worker network isolation not proven

`native_sandbox_network_unenforced` means that with `NATIVE_SANDBOX_LAUNCHER=kubernetes`, Wardby ran a check inside the worker pod and it did not pass before the time limit. The check requires the gateway to be reachable on port 8790 while the gateway's deny port (8791 by default), an outside address, and the cloud metadata server (`169.254.169.254:80`) are not. The message says which part failed. The pod is removed and the run never started.

- **"the gateway was unreachable"**: confirm the gateway Deployment has ready pods, the `wardby-native-gateway` Service (or `NATIVE_GATEWAY_SERVICE`) exposes 8790 and 8791, and the gateway's own NetworkPolicy admits `wardby.io/component: native-run` pods on port 8790.
- **"the gateway's deny port was reachable"** or **"an outside address was reachable"** (or the metadata server): the cluster is not enforcing the per-run NetworkPolicy. Confirm your CNI enforces `NetworkPolicy` (some local clusters need a policy-capable CNI such as Calico), and that no other policy or mesh adds egress for these pods.
- If the Service lacks port 8791, or the gateway's policy does not admit 8791, unprogrammed pods would look isolated. Keep both in place; the check depends on them.
- On a slow node the policy can take longer to program. Retrigger the run once, or raise `NATIVE_SANDBOX_ENFORCEMENT_TIMEOUT_MS` (default 30000), before changing anything.

A cluster that does not enforce NetworkPolicy fails every sandbox run this way, by design. Switch the agent back to `control-plane` if you cannot enable enforcement.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
