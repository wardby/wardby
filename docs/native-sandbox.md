# Native sandbox

By default a native agent runs inside the Wardby server process: its turn loop
and any user tool code you attach execute next to the database connection, the
LLM credentials, and every other agent's runs. **Sandbox mode** moves the whole
turn loop and the agent's user tools into a single-use worker that holds no
credentials, no database access, no container-runtime access, and no network
except one path to a separate **native gateway**. The worker is a Docker
container or, on a Kubernetes cluster, a pod; you choose with
`NATIVE_SANDBOX_LAUNCHER`.

Use it when a native agent runs tool code or prompts you do not fully trust, for
example tools written by people other than the operators, or agents that fetch
and process untrusted content. Leave agents in the default `control-plane` mode
when you trust the tools and want the simplest deployment.

Sandbox mode applies to native agents only. Coding agents have their own
isolation model; see [Coding-worker isolation](coding-worker-isolation.md).

## What is isolated and what is not

| Component                 | Trusted? | Where it runs                            |
| ------------------------- | -------- | ---------------------------------------- |
| Wardby server / scheduler | Yes      | Your host, VM, or cluster                |
| Native gateway            | Yes      | A separate container or Deployment       |
| Postgres, LLM provider    | Yes      | Reachable only from server/gateway       |
| Agent turn loop (worker)  | No       | Single-use container or pod, one per run |
| User tool code (worker)   | No       | The same worker                          |

The Docker worker container:

- has no LLM keys, secrets, database URL, or Docker socket, and receives only a
  run-scoped capability on its standard input (never in its environment,
  arguments, labels, or `docker inspect` output);
- runs as non-root (uid 10001) on a read-only root filesystem with a
  size-capped `/tmp` (no exec), all Linux capabilities dropped,
  `no-new-privileges`, and CPU, memory, and PID limits;
- sits on an internal Docker network created for that run alone, shared only
  with the gateway container, with no route to the internet, the host, or any
  other run.

On Kubernetes the worker is a pod with the same posture; see
[Set up with Kubernetes](#set-up-with-kubernetes) for what the pod and its
NetworkPolicy contain and how the isolation is proven before the run starts.

Everything the worker needs from the outside world (model calls, the built-in
tools, and tool access to datastores, secrets, and outbound fetch) goes through
the gateway, which enforces each tool attachment's grants. A worker can only
ask for what the agent's attachments already allow.

Containers are defense in depth, not a virtual-machine boundary. On Kubernetes,
set a sandboxing runtime class such as gVisor where you have one. Run the Docker
host on a machine that holds no production credentials beyond what the server
and gateway need.

## Topology (Docker)

```
              Docker host
 +---------------------------------------------------------+
 |  wardby serve  (server + scheduler)                     |
 |     |  docker run / network create / network connect    |
 |     v                                                   |
 |  per-run internal network  (no external route)          |
 |   +--------------------+        +--------------------+  |
 |   | native worker      |  HTTP  | native gateway     |  |
 |   | (no credentials)   +------->| wardby-native-     |--+--> LLM provider
 |   | single-use         |        | gateway :8790      |--+--> Postgres
 |   +--------------------+        | (credentials, DB)  |  |
 |                                 +--------------------+  |
 +---------------------------------------------------------+
```

For each run the server creates a new internal network, connects the gateway
container to it under the alias `wardby-native-gateway`, and starts the worker
on it. When the run ends the worker, the network, and the gateway's membership
of it are removed.

The gateway is stateless: all state is in Postgres. You can restart it while
runs are in flight; workers retry their calls. It must not be given the Docker
socket, because workers can reach it.

## Requirements

- **Docker launcher:** Docker on the host that runs `wardby serve` (or
  `wardby scheduler`). The server launches workers with the `docker` CLI, so its
  user must be able to use the Docker daemon. A running native gateway container
  (below) on the same Docker host, with access to the same Postgres database as
  the server.
- **Kubernetes launcher:** a cluster whose CNI enforces `NetworkPolicy`, a
  namespace holding the native gateway, and a server identity with the
  permissions in [Server permissions](#server-permissions).
- The `wardby-native-worker` image, pinned by digest (Docker also accepts a
  local image id; Kubernetes requires a registry digest).
- A running `wardby serve` or `wardby scheduler`. Sub-agents of a sandboxed run
  are started by the scheduler leader (see [Sub-agents](#sub-agents)).

## Set up with Docker

### 1. Choose the worker image

Releases publish the image to the GitHub Container Registry as
`ghcr.io/<org>/wardby-native-worker`. The exact digest-pinned reference for the
installed version is listed as `nativeWorker` in `dist/quickstart-images.json`
inside the npm package. Use that reference as-is:

```dotenv
NATIVE_SANDBOX_WORKER_IMAGE=ghcr.io/your-org/wardby-native-worker@sha256:replace-with-digest
```

The image must be immutable: a `repo@sha256:...` digest or a local image id.
A mutable tag such as `:latest` is refused with
[`native_sandbox_image_not_pinned`](../help/errors/native-sandbox-image-not-pinned.md).

To build it yourself from a repository checkout:

```bash
npm run native-worker:image:local
docker image inspect --format '{{.Id}}' wardby-native-worker:local
```

Use the printed `sha256:...` image id as `NATIVE_SANDBOX_WORKER_IMAGE`. A local
id must already exist on the Docker host; a digest reference is pulled once if
missing.

### 2. Run the native gateway

The gateway is the same Wardby build as the server, started with the
`native-gateway` command. It needs the server's database, LLM, secrets, and
integration settings, and **no Docker access**.

| Gateway variable        | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `NATIVE_GATEWAY_LISTEN` | `host:port` to listen on. Default `0.0.0.0:8790`.                        |
| `DATABASE_URL`          | The same database the server uses.                                       |
| LLM provider keys       | The same provider settings as the server (for example `OPENAI_API_KEY`). |
| `SECRET_APP_KEY`        | Same value as the server, so tools can read their bound secrets.         |
| Integration settings    | The same repository-host and issue-tracker settings as the server.       |

If sandboxed agents delegate to coding agents, give the gateway the same
coding image settings as the server (for example `CODING_WORKER_IMAGE`); the
gateway only resolves them, it never starts coding workers.

For local development, the repository ships a compose overlay
(`deploy/local/docker-compose.native-sandbox.yml`) that runs the gateway next to
the local Postgres from `deploy/local/docker-compose.yml`:

```bash
docker compose -f deploy/local/docker-compose.yml -f deploy/local/docker-compose.native-sandbox.yml --env-file .env.local up -d --build native-gateway
```

The overlay names the container `wardby-native-gateway`, passes the database
URL for the compose network and your LLM keys from the environment file. It
runs with a read-only root filesystem and all capabilities dropped, and mounts
no Docker socket.
It defines its own health check against `/healthz`.

For other deployments, run `wardby native-gateway` in a container built from
the same image as the server, on the same Docker host, with any container
name you choose, and give that name to the server in the next step. Do not
publish its port to the internet; only the per-run networks and your own
health checks need to reach it.

### 3. Configure the server

Add these to the server's environment (`wardby serve` or `wardby scheduler`),
then restart it:

```dotenv
NATIVE_SANDBOX_LAUNCHER=docker
NATIVE_SANDBOX_WORKER_IMAGE=ghcr.io/your-org/wardby-native-worker@sha256:replace-with-digest
NATIVE_GATEWAY_CONTAINER=wardby-native-gateway
```

See [Configuration reference](#configuration-reference) for every variable,
including the Kubernetes ones. A missing required variable, or a launcher other
than `docker` or `kubernetes`, stops the server at startup with a message naming the variable. When
`NATIVE_SANDBOX_LAUNCHER` is unset, sandbox mode is off and any sandbox-mode
run fails closed (see [Failure modes](#failure-modes)).

`JOB_LAUNCHER` (coding agents) is a separate setting; you can enable either,
both, or neither.

### 4. Set an agent's mode

Each native agent has a `nativeExecutionMode` setting:

- `control-plane` (default): the run executes in the server process.
- `sandbox`: the run executes in a worker container as described above.

Set it with the MCP tools `create_agent` or `update_agent` (field
`nativeExecutionMode`, native agents only), or in an import bundle. Setting
`sandbox` is refused while the server has no native sandbox configured.

Each run keeps the mode it started with. Changing an agent affects only the
runs that start afterwards.

## Set up with Kubernetes

With `NATIVE_SANDBOX_LAUNCHER=kubernetes` the server starts one pod per
sandbox run in a namespace you choose and deletes it when the run ends. The
native gateway runs in the same namespace as an ordinary Deployment.

```
 cluster namespace
 +---------------------------------------------------------------+
 |  wardby serve  --create pod / Secret / NetworkPolicy-->        |
 |                                                               |
 |   native-run pod (no credentials)      native gateway pods    |
 |   +---------------------------+  8790  +-------------------+  |
 |   | worker, single-use        +------->| wardby-native-    |--+--> LLM provider
 |   | egress: gateway:8790 only |   x    | gateway Service   |--+--> Postgres
 |   +---------------------------+  8791  +-------------------+  |
 +---------------------------------------------------------------+
```

### 1. Choose the worker image

Use the digest-pinned `nativeWorker` reference from
`dist/quickstart-images.json`, or push your own build to a registry your
cluster can pull from. The reference must be a registry digest,
`repo@sha256:...`. A local image id means nothing to a cluster, and a
mutable tag is refused; both stop the server at startup or fail the run with
[`native_sandbox_image_not_pinned`](../help/errors/native-sandbox-image-not-pinned.md).

### 2. Deploy the native gateway

Run `wardby native-gateway` as a Deployment in the run namespace, from the
same Wardby image as the server. Requirements:

- **Environment:** the server's `DATABASE_URL`, `SECRET_APP_KEY` (so tools can
  read their bound secrets), the LLM provider keys, and any integration or
  coding image settings the server has (see the gateway table in the Docker
  setup above). Also `NATIVE_GATEWAY_LISTEN` (default `0.0.0.0:8790`) and
  `NATIVE_GATEWAY_DENY_PORT` (default `8791`). Keep these in a Secret.
- **No Kubernetes access:** `automountServiceAccountToken: false` and no Role
  or RoleBinding. Workers can reach the gateway, so it must not be able to
  touch the cluster. A read-only root filesystem with a small `/tmp`,
  all capabilities dropped, and a non-root user all apply.
- **Pod label:** `app.kubernetes.io/name: wardby-native-gateway`. The per-run
  NetworkPolicy selects the gateway pods by this label.
- **A ClusterIP Service** named `wardby-native-gateway` (or set
  `NATIVE_GATEWAY_SERVICE`) exposing **both** port 8790 and the deny port 8791. Nothing is served on 8791; it exists only so isolation can be proven.
- **A NetworkPolicy on the gateway pods** that admits pods labeled
  `wardby.io/component: native-run` on **both 8790 and 8791**, with egress to
  cluster DNS, the model providers (HTTPS), and the database. Do not drop the
  8791 rule: the check that a worker cannot reach 8791 only means something if
  8791 is open at the destination, so that the worker's own policy is the only
  thing that can block it. Without it, a worker whose policy was never
  programmed would read the port as blocked and its isolation could be
  wrongly proven.
- Replicas are fine; the gateway is stateless.

The Kubernetes harness in `deploy/kind-coding/manifests/overlays/kind/`
contains a reference Deployment, Service, and NetworkPolicy
(`native-gateway.yaml`) you can copy and adapt. The cloud overlays under
`deploy/` do not ship the gateway yet, so on those you add the manifests
yourself.

### 3. Server permissions

The server (`wardby serve` or `wardby scheduler`) needs a Role in the run
namespace that allows:

| Resource                            | Verbs                             |
| ----------------------------------- | --------------------------------- |
| `pods`                              | `create`, `get`, `delete`, `list` |
| `pods/exec`                         | `create`, `get`                   |
| `secrets`                           | `create`, `delete`                |
| `networking.k8s.io/networkpolicies` | `create`, `get`, `delete`         |
| `services`                          | `get`                             |

`list` on pods lets the startup sweep find leftover worker pods by label;
`pods/exec` is how the server proves isolation from inside the pod; `services`
is read once to find the gateway's ClusterIP. Coding runs on Kubernetes use a
largely overlapping Role (`deploy/kind-coding/manifests/base/launcher-role.yaml`).

### 4. Configure the server

```dotenv
NATIVE_SANDBOX_LAUNCHER=kubernetes
NATIVE_SANDBOX_WORKER_IMAGE=registry.example.com/wardby-native-worker@sha256:replace-with-digest
NATIVE_SANDBOX_NAMESPACE=wardby
```

Optional: `KUBERNETES_CONTEXT` (the kubeconfig context; unset uses the
in-cluster identity or the current context), `NATIVE_SANDBOX_RUNTIME_CLASS`
(for example a gVisor class), `NATIVE_GATEWAY_SERVICE`, and the CPU and memory
limits. See [Configuration reference](#configuration-reference). Then set
agents to `sandbox` mode as described in
[Set an agent's mode](#4-set-an-agents-mode).

### What each run gets

For every run the server creates, then deletes when the run ends:

- A **Secret** holding the run's input and capability, immutable and mounted
  read-only into the pod. The capability is never in the pod's environment,
  arguments, or labels.
- A **NetworkPolicy** selecting only that pod: no ingress, and egress only to
  the gateway pods on port 8790.
- The **pod**, with no service-account token, non-root (uid and fsGroup
  10001), a read-only root filesystem with a 64 MiB `/tmp`, all capabilities
  dropped, no privilege escalation, the runtime-default seccomp profile, CPU
  and memory requests equal to limits, and `activeDeadlineSeconds` set to the
  run's deadline. Kubernetes has no per-pod process limit, so
  `NATIVE_SANDBOX_PIDS` does not apply.

Workers dial the gateway Service's ClusterIP, so they need no DNS egress. Set
`NATIVE_GATEWAY_URL` only to override that.

### How isolation is proven

A NetworkPolicy takes effect a few seconds after its pod starts, so the run
does not begin until the server has proven the isolation. A new sandbox run
starts **not ready**: the gateway refuses every call from it with a
`not_ready` response, and the worker keeps retrying. Meanwhile the server:

1. Reads back the pod and NetworkPolicy it created and compares them with what
   it built. If an admission controller or mutating webhook changed the
   security-relevant parts (service-account token, host networking, runtime
   class, image, container security context, extra containers, or the policy),
   the run fails with
   [`native_sandbox_isolation_mismatch`](../help/errors/native-sandbox-isolation-mismatch.md).
2. Waits for the pod to run, then executes a short probe inside it. The probe
   must reach the gateway on 8790, must fail to reach the gateway's deny port
   8791 at the same address, and must fail to reach an outside address.
3. Only when the probe passes does it mark the run ready. The gateway then
   accepts the worker's calls.

If the probe cannot pass within its time limit the run fails with
[`native_sandbox_network_unenforced`](../help/errors/native-sandbox-network-unenforced.md)
and the pod is removed. What operators see while this happens: a run that
stays in its starting state for a few seconds (longer on a cold image pull),
and nothing in the model or tool logs until it is ready. A cluster whose CNI
does not enforce NetworkPolicy fails every sandbox run this way, by design.

## Configuration reference

| Variable                       | Launcher   | Required | Default                                                                                                         | Purpose                                                                                                                   |
| ------------------------------ | ---------- | -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NATIVE_SANDBOX_LAUNCHER`      | both       | Yes      | unset (sandbox off)                                                                                             | `docker` or `kubernetes`. Independent of `JOB_LAUNCHER`.                                                                  |
| `NATIVE_SANDBOX_WORKER_IMAGE`  | both       | Yes      |                                                                                                                 | Pinned worker image. Docker: `repo@sha256:...` or a local image id. Kubernetes: a registry digest `repo@sha256:...` only. |
| `NATIVE_GATEWAY_CONTAINER`     | Docker     | Yes      |                                                                                                                 | Name of the running gateway container the server connects to each run's network.                                          |
| `NATIVE_SANDBOX_NAMESPACE`     | Kubernetes | No       | `KUBERNETES_NAMESPACE`, else `wardby-coding`                                                                    | Namespace for run pods and the gateway.                                                                                   |
| `KUBERNETES_CONTEXT`           | Kubernetes | No       | in-cluster or current context                                                                                   | Kubeconfig context the server uses.                                                                                       |
| `NATIVE_SANDBOX_RUNTIME_CLASS` | Kubernetes | No       | `KUBERNETES_RUNTIME_CLASS`, else none                                                                           | RuntimeClass for run pods (for example gVisor).                                                                           |
| `NATIVE_GATEWAY_SERVICE`       | Kubernetes | No       | `wardby-native-gateway`                                                                                         | Name of the gateway Service in the run namespace.                                                                         |
| `NATIVE_GATEWAY_URL`           | both       | No       | Docker: `http://wardby-native-gateway:8790/native-gateway/v1/call`; Kubernetes: the Service's ClusterIP on 8790 | What workers dial. Change only if the gateway is reachable another way. Must be an `http(s)` URL.                         |
| `NATIVE_SANDBOX_CPUS`          | both       | No       | `1`                                                                                                             | CPU limit per worker (Kubernetes: request and limit).                                                                     |
| `NATIVE_SANDBOX_MEMORY_MB`     | both       | No       | `512`                                                                                                           | Memory limit per worker (Docker: swap disabled; Kubernetes: request and limit).                                           |
| `NATIVE_SANDBOX_PIDS`          | Docker     | No       | `128`                                                                                                           | Process limit per worker. Ignored on Kubernetes.                                                                          |

Gateway-side variables (`NATIVE_GATEWAY_LISTEN`, `NATIVE_GATEWAY_DENY_PORT`) are
set on the gateway, not the server.

## Limits and deadline

- Each worker is limited by `NATIVE_SANDBOX_CPUS`, `NATIVE_SANDBOX_MEMORY_MB`,
  and (Docker only) `NATIVE_SANDBOX_PIDS`, with a 64 MiB `/tmp`. Raise the
  limits if tools run out of memory or processes.
- A sandbox run has a maximum lifetime of 60 minutes. Past it the worker is
  stopped and the run fails with `native_sandbox_deadline_exceeded`.
- The agent's own turn and budget limits still apply as for any native agent.

## Sub-agents

A sandboxed run can delegate to sub-agents, including several in parallel.
Sub-agents of a sandboxed run are always **managed runs**: the gateway records
the delegation, and the server's scheduler leader starts the child on its next
tick (about every 10 seconds). Each delegation therefore adds up to about ten
seconds of start-up latency, and `wardby serve` or `wardby scheduler` must be
running or the child never starts.

A child runs in its own configured mode (a `control-plane` child runs in the
server, a `sandbox` child in its own worker). Cancelling a parent run stops its
open children.

## Budget behavior

The gateway is the budget authority for sandboxed runs. Before each model call
it reserves that call's worst-case cost against the run's budget (and any
budget group), calls the provider, then settles at the actual usage. A call the
remaining budget cannot cover is refused and the run ends `budget_exhausted`
instead of overspending. The worker cannot raise or bypass its budget because it
never talks to the provider directly.

## Failure modes

| Error code                                                                                   | Meaning                                                                                                   | What to do                                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`native_sandbox_unavailable`](../help/errors/native-sandbox-unavailable.md)                 | Agent is in `sandbox` mode but the server has no native sandbox. Fails before any spend.                  | Configure the sandbox (steps above) or set the agent back to `control-plane`.            |
| [`native_sandbox_worker_exited`](../help/errors/native-sandbox-worker-exited.md)             | The worker ended without producing a result.                                                              | Check the tool code and the worker's memory and PID limits; run again.                   |
| [`native_sandbox_deadline_exceeded`](../help/errors/native-sandbox-deadline-exceeded.md)     | The run passed its 60-minute maximum; the worker was stopped.                                             | Split the work into smaller runs or sub-agents.                                          |
| [`native_sandbox_worker_lost`](../help/errors/native-sandbox-worker-lost.md)                 | The worker container or pod disappeared (for example its host or node restarted). It is never relaunched. | Trigger the run again; check the Docker host or node stability.                          |
| [`native_sandbox_image_not_pinned`](../help/errors/native-sandbox-image-not-pinned.md)       | `NATIVE_SANDBOX_WORKER_IMAGE` is a mutable tag.                                                           | Use a `repo@sha256:...` digest or a local image id.                                      |
| [`native_sandbox_docker_failed`](../help/errors/native-sandbox-docker-failed.md)             | A Docker command (pull, network create, connect, run) failed.                                             | Read the message, then check the Docker daemon, image availability, and gateway name.    |
| [`native_sandbox_network_unenforced`](../help/errors/native-sandbox-network-unenforced.md)   | Kubernetes: the pod's egress isolation could not be proven in time; the pod was removed.                  | Check that the CNI enforces NetworkPolicy and the gateway Service exposes 8790 and 8791. |
| [`native_sandbox_isolation_mismatch`](../help/errors/native-sandbox-isolation-mismatch.md)   | Kubernetes: the stored pod or NetworkPolicy differs from what Wardby built (an admission change).         | Exempt the run namespace's native-run pods from mutating policies.                       |
| [`native_sandbox_gateway_unavailable`](../help/errors/native-sandbox-gateway-unavailable.md) | Kubernetes: the gateway Service is missing or has no ClusterIP.                                           | Create the Service (ClusterIP, not headless) or fix `NATIVE_GATEWAY_SERVICE`.            |
| [`native_sandbox_worker_unready`](../help/errors/native-sandbox-worker-unready.md)           | Kubernetes: the worker pod did not reach Running in time.                                                 | Check image pull, quotas, and scheduling with `kubectl describe pod`.                    |

A run's error appears in its `error` field in `get_run` and `list_runs`.

## Roll back

Set the agent back to `control-plane` with `update_agent`. Runs already started
keep their mode until they finish. To switch sandbox mode off for the whole
deployment, unset `NATIVE_SANDBOX_LAUNCHER`; sandbox-mode agents then fail
closed with `native_sandbox_unavailable` rather than running unisolated, so move
them back to `control-plane` first if they should keep running.

## Troubleshooting

- **Gateway health.** `GET /healthz` on the gateway returns `{"ok":true}` when
  its database answers and 503 otherwise. From the Docker host:
  `docker exec wardby-native-gateway node -e "fetch('http://127.0.0.1:8790/healthz').then(r => r.text()).then(console.log)"`.
- **List worker containers.** Workers and networks carry the label
  `io.wardby.component=native-worker`:
  `docker ps --all --filter label=io.wardby.component=native-worker`.
  The server removes finished workers and, at startup, sweeps leftovers whose
  runs have ended or passed their deadline.
- **Kubernetes: list worker pods.** Run pods carry the label
  `wardby.io/component=native-run`:
  `kubectl get pods -n <namespace> -l wardby.io/component=native-run`.
  The server removes finished pods (with their Secret and NetworkPolicy) and,
  at startup, sweeps leftovers whose runs have ended or passed their deadline.
- **Kubernetes: gateway health.** `kubectl get deploy,svc,endpoints -n <namespace> wardby-native-gateway`;
  the Service must list ports 8790 and 8791 and have ready endpoints.
- **Check a run.** Call `get_run` for the run's status and error code, then use
  the matching error article from `search_help` or `get_help_article`.
- **Workers cannot reach the gateway.** Confirm `NATIVE_GATEWAY_CONTAINER`
  matches the running container's name exactly and that the gateway listens on
  the port in `NATIVE_GATEWAY_URL` (default 8790).
- **Sub-agents never start.** Confirm `wardby serve` or `wardby scheduler` is
  running; the scheduler leader starts them.
- **Tool code fails inside the sandbox.** The worker has no network except the
  gateway and a read-only filesystem apart from `/tmp`; tools must use the
  provided fetch, datastore, and secret functions.

See also [Security deployment](security-deployment.md) and the
[runtime architecture](architecture-runtime.md).
