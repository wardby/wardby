---
id: native-sandbox
title: Run native agents in a sandbox
summary: Turn on sandbox mode so a native agent's turn loop and tools run in a single-use, credential-free Docker container or Kubernetes pod behind a native gateway.
audience: operator
tags: [native-agents, sandbox, isolation, docker, kubernetes, native-gateway, security]
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
   `control-plane` or `sandbox`; native agents only). `sandbox` is refused when
   the server has no native sandbox configured. Each run keeps the mode it
   started with.

### Kubernetes

Set `NATIVE_SANDBOX_LAUNCHER=kubernetes` instead and the server starts one pod
per run. Run the gateway as a Deployment in the run namespace with a ClusterIP
Service that exposes both 8790 and the deny port 8791, and a NetworkPolicy that
admits `wardby.io/component: native-run` pods on both ports (keep the 8791
rule). On the server set `NATIVE_SANDBOX_WORKER_IMAGE` to a registry digest
(`repo@sha256:...`; a local image id is not accepted), and optionally
`NATIVE_SANDBOX_NAMESPACE` (default `KUBERNETES_NAMESPACE`, else
`wardby-coding`), `KUBERNETES_CONTEXT`, `NATIVE_SANDBOX_RUNTIME_CLASS` (for
example gVisor), and `NATIVE_GATEWAY_SERVICE` (default
`wardby-native-gateway`). `NATIVE_SANDBOX_PIDS` applies to Docker only. The
server needs permission in that namespace to create, get, and delete pods,
Secrets, and NetworkPolicies, list pods, exec into pods, and get Services.

Each run starts "not ready": the gateway refuses the worker until the server
has verified the pod and its NetworkPolicy and proven from inside the pod that
the gateway answers while the deny port and the outside world do not. Failures
there are
[native_sandbox_network_unenforced](errors/native-sandbox-network-unenforced.md),
[native_sandbox_isolation_mismatch](errors/native-sandbox-isolation-mismatch.md),
[native_sandbox_gateway_unavailable](errors/native-sandbox-gateway-unavailable.md),
and [native_sandbox_worker_unready](errors/native-sandbox-worker-unready.md).

The full procedure, topology, and local compose overlay are in
[Native sandbox](../docs/native-sandbox.md).

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

Set the agent back to `control-plane`. Runs already started keep their mode
until they finish.

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

See also [Use native agents, tools, and data](native-capabilities.md) and
[Understand Wardby security boundaries](security.md).
