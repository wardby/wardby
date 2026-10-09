---
id: native-sandbox
title: Run native agents in a sandbox
summary: Turn on sandbox mode so a native agent's turn loop and tools run in a single-use, credential-free Docker container or Kubernetes pod behind a native gateway.
audience: operator
tags: [native-agents, sandbox, isolation, docker, kubernetes, native-gateway, security, warm-pool]
appliesTo: ">=0.5.4"
---

# Run native agents in a sandbox

By default a native agent runs inside the Wardby server. Set its
`nativeExecutionMode` to `sandbox` and its whole turn loop and user tools run in
a single-use Docker container or Kubernetes pod (the `wardby-native-worker`
image) instead. The
container has no credentials, no database access, no Docker socket, and no
network except the **native gateway**, a separate trusted container that holds
the LLM credentials and enforces each tool attachment's grants. The server and
gateway are trusted; the agent loop and user tool code are not.

## Turn it on

1. Run the gateway: `wardby native-gateway` in a container with the server's
   database, LLM, secrets, and integration settings, listening on
   `NATIVE_GATEWAY_LISTEN` (default `0.0.0.0:8790`; `GET /healthz`). Give it no
   Docker socket.
2. On the server (`wardby serve` or `wardby scheduler`) set
   `NATIVE_SANDBOX_LAUNCHER=docker`, `NATIVE_SANDBOX_WORKER_IMAGE` (a
   `repo@sha256:...` digest or local image id), and `NATIVE_GATEWAY_CONTAINER`
   (the gateway container's name). Optional: `NATIVE_GATEWAY_URL`,
   `NATIVE_SANDBOX_CPUS` (1), `NATIVE_SANDBOX_MEMORY_MB` (512),
   `NATIVE_SANDBOX_PIDS` (128).
3. Set the mode with `create_agent` or `update_agent` (`nativeExecutionMode`:
   `control-plane` or `sandbox`; native agents only), or from the CLI with
   `wardby agent create ... --native-execution-mode sandbox` or
   `wardby agent mode <name> sandbox`. `sandbox` is refused when the server
   (or, for the CLI, its environment) has no native sandbox configured. Each
   run keeps the mode it started with; `get_run` shows it.

### Kubernetes

Set `NATIVE_SANDBOX_LAUNCHER=kubernetes` instead and the server starts one pod
per run. Run the gateway as a Deployment in the run namespace with a ClusterIP
Service that exposes both 8790 and the deny port 8791, and a NetworkPolicy that
admits `wardby.io/component: native-run` pods on both ports (keep the 8791
rule). On the server set `NATIVE_SANDBOX_WORKER_IMAGE` to a registry digest
(`repo@sha256:...`; a local image id is not accepted), and optionally
`NATIVE_SANDBOX_NAMESPACE` (default `KUBERNETES_NAMESPACE`, else
`wardby-coding`), `KUBERNETES_CONTEXT`, `NATIVE_SANDBOX_RUNTIME_CLASS` (for
example gVisor), `NATIVE_GATEWAY_SERVICE` (default `wardby-native-gateway`),
`NATIVE_SANDBOX_PRIORITY_CLASS` (not a `system-` class),
`NATIVE_SANDBOX_MAX_CONCURRENT` (cap on simultaneous sandbox runs across all
replicas; unset means no cap), `NATIVE_SANDBOX_READY_TIMEOUT_MS` (default 120000) and `NATIVE_SANDBOX_ENFORCEMENT_TIMEOUT_MS` (default 30000).
`NATIVE_SANDBOX_PIDS` applies to Docker only. On GKE Autopilot also set
`KUBERNETES_PLATFORM=gke-autopilot`: pod resources are conformed to Autopilot's
rules and the gVisor runtime class is required. The shipped GKE deployment
runs the gateway for you; see the GKE guide. The
server needs permission in that namespace to create, get, and delete pods,
Secrets, and NetworkPolicies, list pods, exec into pods, and get Services.

Each run starts "not ready": the gateway refuses the worker until the server
has verified the pod and its NetworkPolicy and proven from inside the pod that
the gateway answers while the deny port, the outside world, and the cloud
metadata server do not. Failures
there are
[native_sandbox_network_unenforced](errors/native-sandbox-network-unenforced.md),
[native_sandbox_isolation_mismatch](errors/native-sandbox-isolation-mismatch.md),
[native_sandbox_gateway_unavailable](errors/native-sandbox-gateway-unavailable.md),
and [native_sandbox_worker_unready](errors/native-sandbox-worker-unready.md).
A start past the concurrent cap or the namespace quota fails with
[native_sandbox_capacity](errors/native-sandbox-capacity.md).

The full procedure, topology, and local compose overlay are in
[Native sandbox](../docs/native-sandbox.md).

### Warm pool

Set `NATIVE_SANDBOX_WARM_POOL_SIZE` (0 to 50, default 0 = off) to keep that many
idle, already-isolated workers ready, with either launcher. A run claims one
atomically through the database; its input and one-time gateway capability are
delivered over exec stdin only after the claim, and the worker is still
single-use. `NATIVE_SANDBOX_WARM_MAX_AGE_MS` (60000 to 21600000, default 1800000) replaces idle workers older than that. With no idle worker, or one that
fails the claim-time re-check, the run cold-launches as usual. If delivery fails
and the worker cannot be confirmed gone within 30 seconds, the run fails with
[native_sandbox_warm_delivery_failed](errors/native-sandbox-warm-delivery-failed.md).

Idle workers are extra pods or containers: the Kubernetes ResourceQuota needs
room for `NATIVE_SANDBOX_MAX_CONCURRENT` plus the pool size, and each idle
worker reserves its CPU and memory (billed on GKE Autopilot). Rebuild the worker
image so it can be a pool worker. Pool workers are named `wardby-nwarm-<token>`
and labelled `wardby.io/pool=warm`; logs use module `native-warm-pool`. Details
are in [Native sandbox](../docs/native-sandbox.md#warm-pool).

## What to expect

- The worker is read-only, non-root (uid 10001), has all capabilities dropped, a
  size-capped `/tmp`, and CPU, memory, and PID limits. Each run gets its own
  internal network shared only with the gateway.
- The gateway is the budget authority: it reserves each model call's worst-case
  cost first and settles at actual usage. A call the budget cannot cover ends the
  run `budget_exhausted`.
- Sub-agents of a sandboxed run are managed runs started by the scheduler
  leader on its next tick (about every 10 seconds), so the server or scheduler
  must be running.
- A sandbox run has a 60-minute maximum lifetime.

## Roll back

Set the agent back to `control-plane`. Only new runs are affected: runs
already started in sandbox mode finish there.

## Troubleshooting

Check the gateway with `GET /healthz`, list worker containers with
`docker ps --all --filter label=io.wardby.component=native-worker`, and read the
run's error with `get_run`. On Kubernetes list worker pods with
`kubectl get pods -n <namespace> -l wardby.io/component=native-run`. Error
codes:

- [native_sandbox_unavailable](errors/native-sandbox-unavailable.md)
- [native_sandbox_worker_exited](errors/native-sandbox-worker-exited.md)
- [native_sandbox_deadline_exceeded](errors/native-sandbox-deadline-exceeded.md)
- [native_sandbox_worker_lost](errors/native-sandbox-worker-lost.md)
- [native_sandbox_image_not_pinned](errors/native-sandbox-image-not-pinned.md)
- [native_sandbox_docker_failed](errors/native-sandbox-docker-failed.md)
- [native_sandbox_network_unenforced](errors/native-sandbox-network-unenforced.md)
- [native_sandbox_isolation_mismatch](errors/native-sandbox-isolation-mismatch.md)
- [native_sandbox_gateway_unavailable](errors/native-sandbox-gateway-unavailable.md)
- [native_sandbox_worker_unready](errors/native-sandbox-worker-unready.md)
- [native_sandbox_capacity](errors/native-sandbox-capacity.md)
- [native_sandbox_warm_delivery_failed](errors/native-sandbox-warm-delivery-failed.md)
- [native_sandbox_requires_catalog](errors/native-sandbox-requires-catalog.md)

See also [Use native agents, tools, and data](native-capabilities.md) and
[Understand Wardby security boundaries](security.md).
