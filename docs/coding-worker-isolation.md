# Coding Worker Isolation

Date: 2026-09-07

Status: Tasks 8-10 complete; the routed container executor, Docker JobLauncher,
and trusted VCS finalizer execute and attest this policy without weakening it.

## Security Boundary

Coding-agent repositories and instructions are untrusted. The Docker daemon,
host kernel, Reevo control plane, immutable worker image, and dedicated coding
proxy are trusted. Containers are defense in depth rather than a VM boundary;
production should run the Docker host on a dedicated worker node or VM with no
production credentials beyond those required by the proxy.

The worker has one network attachment: a unique per-run internal bridge using
Docker's isolated gateway mode. It has no default external route, published
port, host mapping, custom DNS server, or direct connection to the control
plane. A dedicated proxy container is attached to both that internal network
as `reevo-proxy` and an external network. No other service may join the run
network.

The proxy accepts a run-scoped capability, resolves only exact configured HTTPS
hostnames, rejects IP literals and every private, loopback, link-local,
documentation, transition, multicast, and metadata address, rejects mixed DNS
answers, and pins the vetted address into the socket lookup. Redirects are
denied. Injected fetch implementations are a test seam and must not be used in
production composition.

## Container Policy

`src/providers/jobs/docker-isolation.ts` is the canonical policy builder and
startup attestation layer. `DockerJobLauncher` executes its argument arrays
directly with `spawn`; it never invokes a shell.

The worker policy requires:

- An immutable `sha256:` image ID or repository digest with `--pull never`.
- UID/GID `10001:10001`, all capabilities dropped, no new privileges, Docker's
  built-in seccomp profile, private cgroup and PID namespaces, and no host IPC.
- A read-only root filesystem with bounded `noexec,nosuid,nodev` tmpfs mounts
  for `/tmp` and `/home/reevo`.
- Exact CPU, memory, equal memory+swap, PID, shared-memory, disk, and wall-clock
  limits. Equal memory and memory+swap disables additional swap allowance.
- No devices, device requests, bind mounts, extra groups, custom DNS, extra
  hosts, published ports, or restart policy.
- At most 2 MiB of local Docker logs and a cooperative SIGTERM grace period
  before forced termination.

The capability value is inherited from the trusted launcher's child-process
environment with `--env REEVO_RUN_CAPABILITY`; it is never included in command
arguments. Docker administrators can still inspect container environment, so
daemon access remains privileged and must be tightly restricted.

## Ephemeral Storage

Each run receives one quota-bounded local tmpfs volume. A hardened, no-network
keeper container holds the volume open from preparation through result
collection. It creates exactly four private subdirectories and emits
`reevo_storage_ready` before the launcher may seed them.

The worker sees only these volume subpaths:

- `/workspace`: read-write checkout files.
- `/workspace/.git`: read-only Git metadata.
- `/run/reevo/input`: read-only, validated input artifact.
- `/run/reevo/output`: read-write result artifact.

There are no production host bind mounts. The Docker JobLauncher transfers data
through the keeper with Docker copy/archive APIs, validates it before launch and
after collection, and stops the keeper only after collection. Stopping the last
container that mounts this local tmpfs intentionally destroys the run data.
The quota is RAM-backed; operators must bound aggregate concurrent `diskMb`
allocations at the host scheduler as well as per run.

## Required Lifecycle

1. Validate `JobSpec`, image digest, proxy identity, and host support.
2. Create and inspect the internal network and tmpfs volume.
3. Create, inspect, and start the keeper; wait for its readiness marker.
4. Seed the four fixed storage areas through the keeper, never a bind mount.
5. Attach the dedicated proxy and attest that it is both internally and
   externally connected.
6. Create the worker with the run capability supplied only in the child
   environment; inspect every effective control before start.
7. Start the worker and enforce `deadlineMs`. Send SIGTERM at expiry, then
   SIGKILL after `stopGraceSeconds` if it remains alive.
8. Cancel the proxy session, collect and validate bounded output, and re-read
   authoritative usage before any repository publication.
9. For `changes_ready` only, copy the worker workspace into a new host staging
   directory, reject special files, nested `.git`, escaping symlinks, and size
   or entry-limit violations, then atomically replace the trusted checkout.
10. Revalidate protected paths, Git configuration, branch ancestry, remotes,
    and budget; create one controlled commit, push one deterministic branch,
    and create or find one draft pull request.
11. Persist the typed coding result and terminal run status in one transaction,
    then remove the worker, keeper, network, volume, input artifact, and VCS
    workspace. `no_changes` and `budget_exhausted` never push.

`ContainerExecutor` treats a durable proxy session without a durable job handle
as ambiguous provisioning and never relaunches it. A persisted handle is the
only recovery path. Duplicate starts, terminal collection, Git finalization,
and cleanup converge on the same handle, branch, commit, pull request, usage,
and status.

Any missing host feature, unsupported network option, failed inspection,
unexpected mount/network/environment, or cleanup ambiguity is the fixed
`docker_isolation_unsupported` failure. Production must not fall back to a
weaker profile.

## Control Plane Configuration

Set `JOB_LAUNCHER=docker`, `CODING_WORKER_IMAGE` to an immutable repository
digest, and `CODING_PROXY_CONTAINER` to the dedicated proxy container name.
`VCS_WORK_ROOT`, `CODING_JOB_STATE_ROOT`, and `CODING_ARTIFACT_ROOT` must be
trusted host-only directories. Resource limits are controlled by
`CODING_CPUS`, `CODING_MEMORY_MB`, `CODING_PIDS`, and `CODING_DISK_MB`.

The GitHub adapter requires `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; the
App installation is checked while preparing the workspace, before the
billable proxy session is created. The upstream key remains behind
`CODING_OPENAI_CREDENTIAL_REF` and is never written to the database, input
artifact, Docker arguments, or Git workspace.

## Verification

Build the image and run the destructive, self-cleaning acceptance suite:

```sh
docker build -f src/coding-worker/Dockerfile -t reevo-coding-worker:task8 .
npm run test:docker-isolation
```

Set `REEVO_WORKER_IMAGE` to test another local tag. The runner resolves that
tag to an immutable image ID before testing. The suite verifies effective
Docker inspection, no default route, proxy-only connectivity, denied
Docker-socket/host/metadata/localhost/public access, read-only mounts and
rootfs, zero effective capabilities, seccomp and no-new-privileges, private PID
1, PID exhaustion, OOM containment, disk ENOSPC, and wall-clock termination.

Related Docker references:

- Internal and isolated bridge networks: https://docs.docker.com/reference/cli/docker/network/create/
- CPU, memory, swap, and PID controls: https://docs.docker.com/engine/containers/resource_constraints/
- Seccomp and no-new-privileges: https://docs.docker.com/reference/cli/docker/container/run/
- Tmpfs behavior and limits: https://docs.docker.com/engine/storage/tmpfs/
- Volume subpaths and `nocopy`: https://docs.docker.com/engine/storage/volumes/
