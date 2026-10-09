---
id: errors/native-sandbox-gateway-unavailable
title: Native gateway Service unavailable
summary: On Kubernetes, Wardby could not find a usable native gateway Service, so a sandbox run could not start.
audience: operator
tags: [error, native-agents, sandbox, kubernetes, native_sandbox_gateway_unavailable]
appliesTo: ">=0.5.4"
---

# Native gateway Service unavailable

`native_sandbox_gateway_unavailable` means that with `NATIVE_SANDBOX_LAUNCHER=kubernetes`, the Service named by `NATIVE_GATEWAY_SERVICE` (default `wardby-native-gateway`) does not exist in the sandbox namespace or has no ClusterIP. Workers dial the Service's ClusterIP, so Wardby needs one.

1. Confirm the namespace: `NATIVE_SANDBOX_NAMESPACE`, else `KUBERNETES_NAMESPACE`, else `wardby-coding`.
2. Create the Service there as a regular ClusterIP Service (not headless) that selects the gateway pods (`app.kubernetes.io/name: wardby-native-gateway`) and exposes both 8790 and the deny port 8791.
3. Confirm the server's Role allows `get` on `services` in that namespace.
4. Alternatively set `NATIVE_GATEWAY_URL` to an address workers can dial, and keep the gateway's NetworkPolicy and the workers' egress consistent with it.
5. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
