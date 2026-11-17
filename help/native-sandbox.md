---
id: native-sandbox
title: Run native agents in a sandbox
summary: Turn on sandbox mode so a native agent's turn loop and tools run in a single-use, credential-free Docker container, Kubernetes pod or Agent Substrate actor (substrate, experimental) behind a native gateway.
audience: operator
tags: [native-agents, sandbox, isolation, docker, kubernetes, substrate, native-gateway, security, warm-pool]
appliesTo: ">=0.6.0"
---

# Run native agents in a sandbox

By default a native agent runs inside the Wardby server. Set its
`nativeExecutionMode` to `sandbox` and its whole turn loop and user tools run in
a single-use Docker container, Kubernetes pod or Agent Substrate actor (the
`wardby-native-worker` image) instead. The
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
rules and the gVisor runtime class is required. On Amazon EKS with a gVisor node
group set `KUBERNETES_PLATFORM=eks`, which also requires the gVisor runtime class. The shipped GKE deployment
runs the gateway for you; see the GKE guide. The
server needs permission in that namespace to create, get, and delete pods,
Secrets, and NetworkPolicies, list pods, exec into pods, and get Services.

Each run starts "not ready": the gateway refuses the worker until the server
has verified the pod and its NetworkPolicy and proven from inside the pod that
the gateway answers while the deny port, the outside world, and the cloud
metadata endpoints do not. Failures
there are
[native_sandbox_network_unenforced](errors/native-sandbox-network-unenforced.md),
[native_sandbox_isolation_mismatch](errors/native-sandbox-isolation-mismatch.md),
[native_sandbox_gateway_unavailable](errors/native-sandbox-gateway-unavailable.md),
and [native_sandbox_worker_unready](errors/native-sandbox-worker-unready.md).
A start past the concurrent cap or the namespace quota fails with
[native_sandbox_capacity](errors/native-sandbox-capacity.md).

The full procedure, topology, and local compose overlay are in
[Native sandbox](../docs/native-sandbox.md).

### Agent Substrate (experimental)

Wardby 0.10.1 and later. Set `NATIVE_SANDBOX_LAUNCHER=substrate` to run each
sandbox run as one gVisor actor on Agent Substrate. Pick it when you already run
Substrate (for example for `JOB_LAUNCHER=substrate` coding runs) and want gVisor
and a worker that never holds the run's capability: Substrate's egress gateway
adds it to the worker's requests to the native gateway, the worker's only
destination. Pick Kubernetes when you need the warm pool or a platform Substrate
does not support, such as GKE Autopilot; Docker for a single host.

- On the server set `NATIVE_SANDBOX_WORKER_IMAGE` (a registry digest),
  `NATIVE_GATEWAY_URL` (required, `http://`, the gateway by hostname, not an IP
  address) and the `SUBSTRATE_*` connection variables shared with
  `JOB_LAUNCHER=substrate` (`SUBSTRATE_API_URL`, `SUBSTRATE_TOKEN_FILE`,
  `SUBSTRATE_ATESPACE`, and optionally `SUBSTRATE_CREDENTIALS_NAMESPACE`,
  `SUBSTRATE_KUBE_CONTEXT`, `SUBSTRATE_CA_FILE`, `SUBSTRATE_SERVER_NAME`,
  `SUBSTRATE_WORKER_SELECTOR`). Optional: `NATIVE_SANDBOX_SUBSTRATE_WORKER_SELECTOR`
  (native actors on other workers) and `SUBSTRATE_NATIVE_GOLDEN_WAIT_SEC`
  (default 60). The gateway's NetworkPolicy admits Substrate's egress gateway
  pods on 8790 and on the deny port. If the deny port is not 8791, set
  `NATIVE_GATEWAY_DENY_PORT` on the server too. `NATIVE_SANDBOX_WARM_POOL_SIZE`
  must be 0: every run resumes from the template's golden snapshot instead, and
  the first runs after a template change wait while it builds.
- The gateway's NetworkPolicy must admit Substrate's egress gateway pods on 8790.
  Apply the migrations `20261130000000_native_gateway_worker_removed`,
  `20261130000001_native_substrate_canary`,
  `20261130000002_native_substrate_canary_capability` and
  `20261130000003_native_gateway_worker_exit` with
  `prisma migrate deploy`, then
  start the gateway and server of the same release.
- Before any run launches, a startup canary per template proves that Substrate
  enforces the egress policy. If it finds the deny port or the outside
  reachable, every run is refused with
  [native_sandbox_network_unenforced](errors/native-sandbox-network-unenforced.md)
  until the server restarts. Substrate does not show a worker's exit, so the
  worker runs under a small supervisor that reports its exit code to the
  gateway (`native_sandbox_worker_exited` then carries that code). Launch
  failures are
  `native_sandbox_substrate_failed` (article
  `errors/native-sandbox-substrate-failed`, Wardby 0.10.1 and later).
- Old templates are not removed automatically; delete them with Substrate's
  tooling. `GET /admin/api/infra` names the current one.

Details are in
[Set up with Agent Substrate](../docs/native-sandbox.md#set-up-with-agent-substrate-experimental).

### Warm pool

Set `NATIVE_SANDBOX_WARM_POOL_SIZE` (0 to 50, default 0 = off) to keep that many
idle, already-isolated workers ready, with the Docker or Kubernetes launcher. A run claims one
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
  must be running. A coding agent child is resolved by the server when it
  starts (worker image, services, knowledge), so the gateway needs no `CODING_*`
  settings; a problem there (such as a `workerImageRef` that is not pinned by digest)
  shows as the child run `failed` or `refused`; the parent's `delegate_to_*`
  call receives `status: "failed"` with the `errorCode`, or for a refused child
  the refusal sentence, and the full error is on the child run (`get_run`).
  Upgrade `wardby serve` and `wardby scheduler` before or together with the
  gateway: an older server starts the child unresolved (a Codex child on the
  default image without its instructions, a Claude Code child failing with
  `coding_provider_not_configured:claude-code`).
- A sandbox run has a 60-minute maximum lifetime.
- `stop_run` stops a sandbox run: its gateway session ends so the worker exits
  at its next call, and a worker still running after 5 seconds is killed and
  removed (a warm pool worker is discarded, never reused). Search help for
  "stop run" (article `stop-run`, Wardby 0.7.0 and later).

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
- [native_sandbox_gateway_error](errors/native-sandbox-gateway-error.md)
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
- `native_sandbox_substrate_failed` (Substrate; article
  `errors/native-sandbox-substrate-failed`, Wardby 0.10.1 and later)

See also [Use native agents, tools, and data](native-capabilities.md) and
[Understand Wardby security boundaries](security.md).
