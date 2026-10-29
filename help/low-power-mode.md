---
id: low-power-mode
title: Low power mode on GKE
summary: Low power mode: scale the coding proxy and native gateway to zero when idle to cut the cost of a lightly used GKE deployment, and what changes when they wake.
audience: operator
tags: [gke, cost, low-power, scale-to-zero, kubernetes, autoscaling, idle, power_sleep, power_status, sleep now, power:manage]
appliesTo: ">=0.6.0"
---

# Low-power mode on GKE

Low-power mode reduces the cost of a GKE Autopilot deployment that runs agents
only occasionally. When it is on, the coding proxy and the native gateway scale
to zero replicas after an idle window and wake when a run needs them. The
headroom placeholder is off, and the control plane runs 1 copy that scales to 2
under load.

It needs `JOB_LAUNCHER=kubernetes`. Without it Wardby logs `low_power_ignored`
and the mode does nothing.

## Turn it on or off

```sh
WARDBY_HOSTNAME=wardby.example.com WARDBY_LOW_POWER=1 deploy/gke/up.sh
```

Re-running `up.sh` without `WARDBY_LOW_POWER=1` turns it off: it removes the
autoscaler `wardby-control-plane` and the Role and RoleBinding `wardby-power`
and restores proxy 1, gateway 2, headroom 1, control plane 1.

`WARDBY_LOW_POWER` accepts only unset, `0` or `1`; anything else fails `up.sh`
and stops the control plane at start-up. `LOW_POWER_IDLE_MINUTES` is an integer
from 5 to 1440 (default 30) set on the control-plane Deployment; it is read
only when `WARDBY_LOW_POWER=1`.

## How it behaves

- **Sleep.** Every minute the scheduler leader scales the coding proxy
  (`wardby-coding-proxy`) or native gateway (`wardby-native-gateway`) to 0 when
  nothing is pending or running for it and nothing finished within the idle
  window. The gateway also needs no active session. Either target sleeps only
  once at least one idle window has passed since it was last woken (annotation
  `wardby.io/power-woke-at`) and since the control plane started, whichever is
  later. The check repeats just before scaling. Log: `power: proxy slept (idle 30m)`.
- **Wake.** A coding run scales the proxy to 1 and waits for a ready endpoint;
  a sandbox run does the same for the gateway. The wait is at least 5 minutes.
  A `KUBERNETES_READY_TIMEOUT_MS` (proxy) or `NATIVE_SANDBOX_READY_TIMEOUT_MS`
  (gateway) above that, set on the control-plane Deployment, raises it. Expect
  about 1 to 2 minutes extra on a cold node. Log: `power: proxy woke`. A
  sandbox run woken this way may then wait for a gVisor node for its worker
  pod, so its first model call can come several minutes after it started. From
  0.7.0 it shows as running the whole time and is not reaped as orphaned; only
  the wake and pod-start limits above can fail it.
- **Preflight.** The first coding run after a control-plane restart also runs
  the cluster preflight canary, because start-up preflight is deferred while the
  proxy sleeps (`kubernetes_preflight_deferred`).
- **Deploys.** Every `up.sh` run, including one that turns the mode off, marks
  the proxy and gateway as just woken before it brings them back up, so the
  control plane being replaced cannot scale them down mid-deploy. With the mode
  on they stay up through the deploy (its database checks need them) and sleep
  one idle window later.
- **Control plane.** It scales 1 to 2 on CPU (20% target, scale down
  after 10 minutes). A run executes on the copy that started it, so scheduled
  runs stay on the scheduler leader; webhook and MCP-started runs spread. The
  autoscaler owns the replica count while the mode is on.

## Sleep now

To skip the idle window, for example right after a test, call `power_sleep`.
Pass `target: "proxy"` or `target: "gateway"` to sleep one; omit it for both.

- It scales the target to 0 at once, ignoring the idle window and the woke-at
  grace.
- It never stops a run. A target with a pending or running run, or for the
  gateway an active gateway session, stays up, and its run ids are returned:
  `{ "slept": ["proxy"], "blocked": [{ "target": "gateway", "runIds": ["..."] }] }`.
  Recently finished runs do not block it.
- The next run wakes the target as usual.
- Each call is logged with `event: "power.sleep"` and the caller's principal.

`power_status` returns, for each target, `replicas`, `ready`, `wokeAt` and
`blockers` (the run ids keeping it busy).

Both tools need the `power:manage` scope, which only the `admin` role grants
(see [Identity and access](identity-and-access.md)). With the mode off,
`power_sleep` fails with
[`409 low_power_disabled`](errors/low-power-disabled.md) and `power_status`
returns `{ "enabled": false }`.

## Trade-offs and requirements

- With headroom off, the control plane has less protection against preemption.
- The gateway runs 1 replica instead of 2 while awake: no redundancy.
- `NATIVE_SANDBOX_WARM_POOL_SIZE` must be 0, or the control plane refuses to
  start.
- The gateway must be in the same namespace as `KUBERNETES_NAMESPACE`.

## Cost

Autopilot bills Pod requests while a Pod exists. At us-central1 list prices
($0.0445 per vCPU-hour, $0.0049225 per GiB-hour, 730 hours a month; use your
region's rates), always-on cost per workload is: control plane (1.1 vCPU / 2.125
GiB) $43.37, coding proxy (1.1 / 3.125) $46.96, native gateway (0.35 / 0.625 per
replica, two replicas) $27.23, headroom (0.25 / 0.5) $9.92. In low-power mode
the proxy costs $0.0643 an hour and a gateway replica $0.0187 an hour only
while awake, and headroom costs nothing. See
[Getting started on GKE](../docs/getting-started-gke.md#low-power-mode) for the
full table.

## Errors and log lines

- [`low_power_wake_timeout`](errors/low-power-wake-timeout.md): the target did
  not become ready in time, or its Deployment does not exist.
- `native_sandbox_launch_abandoned` (0.7.0 and later): a sandbox run was
  stopped while the gateway woke, so no worker pod was made.
- [`low_power_disabled`](errors/low-power-disabled.md): `power_sleep` was
  called while the mode is off.
- [`low_power_scale_forbidden`](errors/low-power-scale-forbidden.md): the
  control plane may not read or scale a Deployment or read its Endpoints
  (Role `wardby-power` missing or out of date).
- Also: `power_sleep_failed`, `low_power_access_check_failed`,
  `low_power_ignored`.

## Local kind

`WARDBY_LOW_POWER=1 deploy/kind-coding/up.sh` applies the Role. The kind control
plane runs on your host, so set `WARDBY_LOW_POWER=1` (and optionally
`LOW_POWER_IDLE_MINUTES`) in the environment of `wardby serve` too.

Related: [Deploy Wardby on GKE Autopilot](deploy-gke.md),
[Run native agents in a sandbox](native-sandbox.md).
