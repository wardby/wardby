---
id: errors/native-sandbox-network-unenforced
title: Native worker network isolation not proven
summary: Wardby could not prove a sandbox worker's network isolation (a Kubernetes pod, or the Substrate startup canary), so the run was refused.
audience: operator
tags: [error, native-agents, sandbox, kubernetes, substrate, canary, native_sandbox_network_unenforced]
appliesTo: ">=0.6.0"
---

# Native worker network isolation not proven

`native_sandbox_network_unenforced` means that with `NATIVE_SANDBOX_LAUNCHER=kubernetes`, Wardby ran a check inside the worker pod and it did not pass before the time limit. The check requires the gateway to be reachable on port 8790 while the gateway's deny port (8791 by default), an outside address, and the cloud metadata endpoints (`169.254.169.254:80`, the EKS Pod Identity agent `169.254.170.23:80` and `[fd00:ec2::23]:80`, and EC2's IPv6 metadata address `[fd00:ec2::254]:80`) are not. The message says which part failed. The pod is removed and the run never started.

- **"the gateway was unreachable"**: confirm the gateway Deployment has ready pods, the `wardby-native-gateway` Service (or `NATIVE_GATEWAY_SERVICE`) exposes 8790 and 8791, and the gateway's own NetworkPolicy admits `wardby.io/component: native-run` pods on port 8790.
- **"the gateway's deny port was reachable"** or **"an outside address was reachable"** (or a metadata endpoint): the cluster is not enforcing the per-run NetworkPolicy. Confirm your CNI enforces `NetworkPolicy` (some local clusters need a policy-capable CNI such as Calico), and that no other policy or mesh adds egress for these pods.
- If the Service lacks port 8791, or the gateway's policy does not admit 8791, unprogrammed pods would look isolated. Keep both in place; the check depends on them.
- On a slow node the policy can take longer to program. Retrigger the run once, or raise `NATIVE_SANDBOX_ENFORCEMENT_TIMEOUT_MS` (default 30000), before changing anything.

A cluster that does not enforce NetworkPolicy fails every sandbox run this way, by design. Switch the agent back to `control-plane` if you cannot enable enforcement.

## On Substrate

With `NATIVE_SANDBOX_LAUNCHER=substrate` (Wardby 0.10.1 and later) the message is `native_sandbox_network_unenforced: the Substrate egress policy could not be proven for this worker template (<reason>).` Before any run launches, each server process runs a startup canary per worker template: an actor from the same template, under the run's egress rule without the credential, that must reach the gateway's `/healthz` while the gateway's deny port (`NATIVE_GATEWAY_DENY_PORT`, default 8791), an outside address and the cloud metadata endpoints stay unreachable. A probe counts as denied only when its connection never opens, or when its whole answer is exactly the egress gateway's denial (status 403, `server: envoy`, body `egress denied`); any other answer counts as reachable. No Secret or actor of the run was created.

- **`deny_port_reachable`** or **`outside_reachable`**: Substrate let the canary past its egress policy. These are final: every sandbox run is refused until the server restarts. Check Substrate's egress gateway and its policies (restart the egress gateway after a Substrate API-server outage), then restart the server to run a new check. If you changed the gateway's deny port, set `NATIVE_GATEWAY_DENY_PORT` to the same value on the server.
- **`gateway_unreachable`**: the gateway's `/healthz` did not answer, before or after the probes. Check that the gateway is running, that its NetworkPolicy admits Substrate's egress gateway pods on 8790, and that `NATIVE_GATEWAY_URL` names it by a hostname the egress gateway resolves. The next launch runs a new check.
- **`canary_timeout`**: no verdict within 2 minutes; often the gateway could not record it (it must be the same release as the server, with the `20261128000001_native_substrate_canary` migration applied). The next launch runs a new check.
- **`<call>_failed`** or **`canary_failed`**: a call the check needed failed, for example `createActor_failed` or `resumeActor_failed` (Substrate), or `recordCanary_failed` and `readCanary_failed` (the database). The next launch runs a new check; the server's warn line `native substrate canary` has the template and result.

The gateway's NetworkPolicy must admit Substrate's egress gateway pods on the deny port as well as 8790: if the deny port is closed by that policy, the check cannot tell a too-broad egress policy from a correct one.

In low-power mode the check runs on the first sandbox launch, after the gateway is woken. See [Startup isolation check](../../docs/native-sandbox.md#startup-isolation-check).

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
