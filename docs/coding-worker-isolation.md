# Coding Worker Isolation

Date: 2026-09-07

Status: Tasks 8-10 complete; the routed container executor, Docker JobLauncher,
and trusted VCS finalizer execute and attest this policy without weakening it.

## Security Boundary

Coding-agent repositories and instructions are untrusted. The Docker daemon,
host kernel, Wardby control plane, immutable worker image, and dedicated coding
proxy are trusted. Containers are defense in depth rather than a VM boundary;
production should run the Docker host on a dedicated worker node or VM with no
production credentials beyond those required by the proxy.

The Codex worker has one network attachment: a unique per-run internal bridge using
Docker's isolated gateway mode. It has no default external route, published
port, host mapping, custom DNS server, or direct connection to the control
plane. A dedicated proxy container is attached to both that internal network
as `wardby-proxy` and an external network. No other service may join the run
network.

Claude Code uses a credential-separated composite job. Its agent container is
attached only to the proxy bridge and does not mount the repository. Its tool
container mounts the workspace, has `--network none`, and receives no model
capability or provider credential. A credential-free relay connects the two
over a private Unix socket. Both containers, the socket volume, keeper,
network, and artifacts are attested and cleaned as one persisted handle.

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
  for `/tmp` and `/home/wardby`.
- Exact CPU, memory, equal memory+swap, PID, shared-memory, disk, and wall-clock
  limits. Equal memory and memory+swap disables additional swap allowance.
- No devices, device requests, bind mounts, extra groups, custom DNS, extra
  hosts, published ports, or restart policy.
- At most 2 MiB of local Docker logs and a cooperative SIGTERM grace period
  before forced termination.

The capability value is inherited from the trusted launcher's child-process
environment with `--env WARDBY_RUN_CAPABILITY`; it is never included in command
arguments. Docker administrators can still inspect container environment, so
daemon access remains privileged and must be tightly restricted.

## Ephemeral Storage

Each run receives one quota-bounded local tmpfs volume. A hardened, no-network
keeper container holds the volume open from preparation through result
collection. It creates exactly four private subdirectories and emits
`wardby_storage_ready` before the launcher may seed them.

The worker sees only these volume subpaths:

- `/workspace`: read-write checkout files.
- Git metadata remains in the trusted keeper volume and is not mounted into the worker.
- `/run/wardby/input`: read-only, validated input artifact.
- `/run/wardby/output`: read-write result artifact.

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
digest or Docker local image ID, and `CODING_PROXY_CONTAINER` to the dedicated proxy container name.
For Claude Code, also set `CODING_CLAUDE_WORKER_IMAGE` and
`CODING_CLAUDE_TOOL_RUNNER_IMAGE` to their immutable IDs.
`VCS_WORK_ROOT`, `CODING_JOB_STATE_ROOT`, and `CODING_ARTIFACT_ROOT` must be
trusted host-only directories. Resource limits are controlled by
`CODING_CPUS`, `CODING_MEMORY_MB`, `CODING_PIDS`, and `CODING_DISK_MB`.

`CODING_MAX_CONCURRENT` (default `4`) caps coding runs that hold a slot at
once, across every control-plane replica: the cap is enforced in Postgres
inside the provisioning claim, so adding replicas never raises it. A run
over the cap stays `pending` and `get_run` shows `codingQueuedAt`; it starts,
oldest first, when a slot frees (immediately in the process whose run
finished, or on the scheduler leader's next tick). A run still queued after
`CODING_QUEUE_TIMEOUT_SEC` (default `3600`) fails with `coding_queue_timeout`.
Slot usage is derived from run state, so a crashed replica cannot leak slots:
its runs are reconciled to `lost`, which frees them. Clones are shallow
(`--depth 1`); the worker never receives Git history and finalization needs
only the base commit.

The GitHub adapter requires `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; the
App installation is checked while preparing the workspace, before the
billable proxy session is created. Upstream keys remain behind
`CODING_OPENAI_CREDENTIAL_REF` and `CODING_ANTHROPIC_CREDENTIAL_REF` and are
never written to the database, input
artifact, Docker arguments, or Git workspace.

The embedded Codex SDK runs with its inner sandbox disabled because the
worker's Docker boundary is authoritative: it has a read-only root filesystem,
no Linux capabilities, no host mounts or Docker socket, no public network,
and only isolated workspace/output volumes plus the trusted proxy connection.
This avoids relying on a nested sandbox that cannot validate Wardby's
intentionally Git-metadata-free workspace.

Coding-agent authoring and execution are MCP-first. `trigger_agent` accepts
an optional bounded `task` and `baseRef` only for a coding agent owned by the
caller; the chosen values are copied into the immutable run record. Webhooks
use the profile default task unless `allowWebhookTaskOverride` is explicitly
enabled on that coding profile. Coding results returned through `get_run` and
`tasks/get` are validated, redacted summaries/tests only; job handles and
execution policy stay internal.

Operator-only checks and cleanup remain available through the CLI:

```sh
wardby coding preflight
wardby coding cleanup --run-id <id>
```

The preflight command requires Docker mode, validates the pinned worker-image
digest, and confirms the image is available to Docker. Cleanup delegates to
the configured executor so it resolves and stops the persisted container job.

## Audit And Retention

The executor emits metadata-only lifecycle events for queueing, preparation,
launch, running, budget cutoff, stopping, collection, PR creation, terminal
outcome, and cleanup. Events carry run ID, opaque job ID, sanitized failure
category, opaque diagnostic ID, duration, and budget totals only. They never
carry task text, prompts, repository contents, diffs, worker environment, raw
Docker logs, or credentials.

The production log/metrics collector retains those events for 90 days by
default policy. `CodingRun` stores only the sanitized failure category and
diagnostic ID alongside the normal run record; it is not an artifact store.
Every terminal path removes the worker volume, input artifact, job state, and
trusted checkout. Restart reconciliation repeats that cleanup from the
persisted job handle and marks ambiguous provisioning as `lost` instead of
relaunching it.

See [Phase 5 release gate](phase-5-release-gate.md) for the complete evidence
set, live-fixture rules, supported scope, and incident procedure.

## Verification

Build the image and run the destructive, self-cleaning acceptance suite:

```sh
docker build -f src/coding-worker/Dockerfile -t wardby-coding-worker:task8 .
npm run test:docker-isolation
npm run verify:claude-code
```

Set `WARDBY_WORKER_IMAGE` to test another local tag. The runner resolves that
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
