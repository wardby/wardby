# Coding Worker Isolation

Date: 2026-09-07 (Docker isolation); Kubernetes launcher section added 2026-09-22

Status: Docker JobLauncher tasks 8-10 complete; the routed container executor,
Docker JobLauncher, and trusted VCS finalizer execute and attest this policy
without weakening it. The Kubernetes launcher (Phase 12 Plan 2a) is complete
for Codex on `kind`; see its section below for status and known gaps.

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

The proxy also binds a second listener, the **deny port** (`8788`,
`CODING_PROXY_DENY_PORT`), which serves nothing: it accepts a connection,
sends no bytes and closes it immediately
(`src/providers/coding-proxy/deny-port.ts`). It exists so a run pod can prove
its own NetworkPolicy is enforced — see "The enforcement gate" below.

The deny port ships to **every** deployment, not just Kubernetes:
`startConfiguredCodingProxy` is the only proxy entry point, so a Docker
deployment's proxy also binds `0.0.0.0:8788` (and refuses to start if it
cannot). No host port is published for it, so there is no port conflict. In
Docker mode a run container can reach it, since a Docker network has no
port-level policy — that is harmless, because the listener accepts the
connection, sends nothing and closes it. It is not a leak; it is a fact about
reachability that the Kubernetes launcher turns into evidence.

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
`CODING_MAX_DISK_MB` (must be an integer between 64 and 32768 and at least
the effective `CODING_DISK_MB`; **defaults to the effective `CODING_DISK_MB`
itself**, not a larger number) is the operator ceiling on the per-agent
`workspaceDiskMb` coding-profile field described below — without it, any
`agents:write` caller could size a run's workspace disk up to 32 GiB
(Docker: a RAM-backed tmpfs; Kubernetes: an `emptyDir`), times
`CODING_MAX_CONCURRENT`, on every run. Defaulting the ceiling to the
existing disk size means upgrading to this branch changes nothing for a
deployment that doesn't set `CODING_MAX_DISK_MB`: `workspaceDiskMb` stays
inert until an operator explicitly raises the ceiling above `CODING_DISK_MB`.

A coding agent's profile carries an optional `workspaceDiskMb` (MiB; `null`
means "use the deployment default `CODING_DISK_MB`"). It is snapshotted onto
the `CodingRun` at dispatch time, so a later profile edit never changes an
in-flight run's size, and it is capped by `CODING_MAX_DISK_MB`: a run whose
snapshotted `workspaceDiskMb` exceeds the ceiling fails with
`coding_workspace_disk_exceeds_limit`
(`src/providers/executor/container.ts`, the `jobSpec()` check). This check
runs after the workspace has already been cloned onto the control plane, so
an over-ceiling agent still pays for a clone before failing, and the failure
reaches the run record only as the sanitized `coding_failure_workspace:<id>`
(the same generic bucketing every workspace/git-related failure gets) — not
a distinctly labeled "refused" outcome, and not currently logged anywhere
more diagnosable on the control plane. This is a known rough edge (tracked
as a follow-up), not a security gap: no run ever exceeds the ceiling, it
just fails less legibly than it could.

`CODING_MAX_CONCURRENT` (default `4`) caps coding runs that hold a slot at
once, across every control-plane replica: the cap is enforced in Postgres
inside the provisioning claim, so adding replicas never raises it. A run
over the cap stays `pending` and `get_run`/`list_runs` show `codingQueuedAt`;
it starts, oldest first, when a slot frees (immediately in the process whose
run finished, or on the scheduler leader's next tick). A newly dispatched run
never takes a free slot ahead of an older queued run. A run still queued after
`CODING_QUEUE_TIMEOUT_SEC` (default `3600`) fails with `coding_queue_timeout`.
Slot usage is derived from run state, so a crashed replica cannot leak slots:
its runs are reconciled to `lost`, which frees them.

Operating the queue across replicas:

- Every replica must set the same `CODING_MAX_CONCURRENT`. Each claim
  enforces the value of the replica making it, so mismatched values make the
  effective cap depend on which replica dispatched the run.
- Draining on a timer and applying `CODING_QUEUE_TIMEOUT_SEC` need a
  scheduler process (`wardby serve` or `wardby scheduler`). A process that
  only serves MCP (`wardby mcp`) drains only when one of its own coding runs
  finishes; without a scheduler somewhere, queued runs can wait indefinitely
  and never time out.
- Upgrade all replicas together. A replica running a version from before
  the queue ignores the cap, and its reconciler reaps queued runs as `lost`. Clones are shallow
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

## Kubernetes launcher (`JOB_LAUNCHER=kubernetes`)

`KubernetesJobLauncher` (`src/providers/jobs/kubernetes.ts`) implements the
same `WorkspaceJobLauncher` contract as `DockerJobLauncher` and is a drop-in
alternative for deployments with no Docker daemon available to the control
plane (e.g. a Cloud Run host). Everything above `ContainerExecutor` —
proxy sessions, the Git finalizer, workspace validation, recovery, cleanup —
is unchanged; only the container-orchestration seam is replaced. **This
milestone is Codex only:** a Claude Code job spec is refused with
`kubernetes_provider_unsupported` (`validateKubernetesSpec`,
`src/providers/jobs/kubernetes-isolation.ts:127`); Claude Code on Kubernetes
is Plan 2b.

### Enabling it

Set `JOB_LAUNCHER=kubernetes` and `CODING_WORKER_IMAGE` to a **registry
digest** (`repo@sha256:<64 hex>` — a bare `sha256:` local image ID is
rejected; a cluster cannot pull it). Kubernetes-specific settings
(`src/config/providers.ts`, `loadKubernetesJobConfig`):

| Variable                   | Default                                         | Meaning                                                                                                                                                          |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KUBERNETES_NAMESPACE`     | `wardby-coding`                                 | The one namespace holding the proxy and every per-run object.                                                                                                    |
| `KUBERNETES_PROXY_SERVICE` | `wardby-coding-proxy`                           | The proxy's Service name; its ClusterIP is what `hostAliases` points runs at.                                                                                    |
| `KUBERNETES_CONTEXT`       | (unset → in-cluster/default kubeconfig context) | Which kubeconfig context `ClientNodeKubernetesApi` connects with.                                                                                                |
| `KUBERNETES_RUNTIME_CLASS` | (unset)                                         | e.g. `gvisor` on GKE. Unset means pods run without a sandboxing runtime class — logged once per launch as `kubernetes_runtime_class_unset` and development-only. |

The `CODING_CPUS` / `CODING_MEMORY_MB` / `CODING_PIDS` / `CODING_DISK_MB` /
`CODING_MAX_DISK_MB` settings above apply identically; the per-agent
`workspaceDiskMb` profile field sizes the pod's `storage` `emptyDir` the same
way it sizes Docker's tmpfs volume.

### Pod layout

One pod per run, built by the canonical, deny-by-default policy in
`kubernetes-isolation.ts`'s `buildRunPod`:

- An **init container `storage-init`** runs first and creates
  `/run/wardby/storage/{workspace,input,output}` (mode `0700`, owned by uid 10001) before any regular container starts. This exists because kubelet
  creates a subPath mount's target directory root-owned the first time it
  sets up the worker's volume mounts, and the keeper (uid 10001, no Linux
  capabilities) cannot `chmod` a root-owned directory it doesn't own. This
  was found the hard way: every real-cluster run failed
  `kubernetes_pod_start_timeout` until the init container was added (see
  Task 8 in the plan ledger). `keeper.js` itself is unchanged — Docker still
  shares it, and Docker's bind-mount-free volume never had this problem.
- **`keeper`**: trusted, holds the one `storage` volume (an `emptyDir` sized
  `spec.limits.diskMb` MiB, **disk-backed**, not `medium: Memory`) open for
  the pod's life; the seam streams the workspace and input artifact in and
  the output artifact out through it via `kubectl exec`-style calls
  (`tar` in/out). Readiness probe: the `output` subdirectory exists.
- **`worker`**: untrusted. Its command is overridden to a small polling gate
  (`WORKER_GATE`) that waits for `/run/wardby/input/.seeded` before
  `import()`-ing the image's real entrypoint. A pod's containers all start
  together — Kubernetes has no "start this container later" — so the gate is
  what makes "seed first, run second" possible without a native sidecar
  (which Kubernetes terminates when the main container exits, killing the
  keeper before result collection).
- `/tmp` and `/home/wardby` are small `medium: Memory` `emptyDir`s (bounded
  `min(64, max(16, memoryMb/8))` MiB), matching Docker's bounded tmpfs mounts.
- `dnsPolicy: None` with `dnsConfig.nameservers: ["127.0.0.1"]` — **no DNS is
  configured for worker/agent pods at all.** The proxy is reached by name
  (`WARDBY_PROXY_URL=http://wardby-proxy:8787` — `CODING_PROXY_ALIAS` in
  `docker-isolation.ts`, the same alias the Docker launcher uses; this is
  distinct from the `KUBERNETES_PROXY_SERVICE` Kubernetes Service name,
  `wardby-coding-proxy` by default — the proxy checks the `Host` header)
  only because the pod's `hostAliases` maps `wardby-proxy` directly to the
  proxy Service's ClusterIP — closing DNS as an exfiltration channel
  without needing a resolver at all.
- `activeDeadlineSeconds = spec.timeoutSec + POD_DEADLINE_GRACE_SECONDS`
  (300s) — a **backstop only**. The launcher enforces the real wall-clock
  deadline itself (`observePod` in `kubernetes.ts`); the extra 300s exists so
  the keeper survives long enough after the worker's deadline for result
  collection to still succeed. A worker that exits 0 counts as `succeeded`
  only if all three hold: the pod's status reason isn't `DeadlineExceeded`,
  the pod isn't being deleted (`metadata.deletionTimestamp` unset), and the
  terminated container's `finishedAt` is at or before
  `deadlineAt + 5s` (clock-skew slack). This closes off a SIGTERM-trapping
  worker turning a deadline kill into a fake success, while still accepting
  a run that genuinely finished just before its deadline and was only
  observed after it.
- Everything else matches the Docker policy's spirit: uid/gid 10001,
  `runAsNonRoot`, all capabilities dropped, `allowPrivilegeEscalation:
false`, seccomp `RuntimeDefault`, read-only root filesystem, no host
  network/PID/IPC, `automountServiceAccountToken: false`, a dedicated
  no-RBAC service account (`wardby-coding-worker`).

Per-run objects, all labeled `app.kubernetes.io/managed-by: wardby`,
`wardby.io/component: coding-run`, `wardby.io/run-sha256: <sha256(runId)
prefix>`, named `wardby-run-<token>` (`<token>` = first 20 hex chars of
`sha256(runId)`):

- The **pod** and its **NetworkPolicy** (same name).
- A **capability Secret** (`wardby-run-<token>-cap`) holding the run's proxy
  capability, injected only via `secretKeyRef` — never in the pod spec,
  command, or arguments.
- A **record ConfigMap** (also `wardby-run-<token>`) holding all job state —
  phase, deadline, result — updated with optimistic concurrency
  (`resourceVersion`). This replaces local state files and in-process
  timers entirely: any control-plane replica can observe, collect, stop, or
  remove any run, and a restarted process loses nothing.

**Record ConfigMaps are kept as tombstones by design, forever, today.**
`remove()` deletes the pod, NetworkPolicy, and capability Secret, but
deliberately _rewrites the record to `phase: "removed"` instead of deleting
it_ (`kubernetes.ts`, `remove()`) — the contract is that a removed run is
never relaunched, and the record is what a later `launch()` call for the
same run ID checks. Nothing today garbage-collects old tombstones, so they
accumulate — one small ConfigMap per run, forever — until a GC follow-up
ships. **A launch that fails during provisioning accumulates a record too**,
not just a `remove()`d run's tombstone: the failure path writes `phase:
"failed"` and the executor never calls `remove()` for a launch that threw,
so every failed launch leaves a permanent record as well. On a busy cluster
this is etcd growth to budget for operationally, not a correctness or
security problem — see "Known gaps" below.

**The executor persists a run's job handle before calling `jobs.launch()`,
closing the crash window that would otherwise orphan a running pod.** The
Kubernetes handle (`{ backend: "kubernetes", id: "<namespace>/<token>" }`)
is fully derivable from the run ID alone, with no cluster call, so it can be
(and is) written to the run record before the launcher ever creates
anything. If the control plane crashes or is replaced mid-launch — after the
pod has been attested and the worker gate has opened, but before the old
code path would have recorded the handle — the run's handle is already on
record, so restart reconciliation can find, stop, and clean up the pod,
NetworkPolicy, and capability Secret through the normal `abandon()` path
instead of leaking them permanently.

### Attestation — deny-by-default, fail closed

Before the worker gate ever opens, the launcher reads back the created pod
and NetworkPolicy and compares them against the canonical builder's output
with `assertRunPodMatches` / `assertRunNetworkPolicyMatches`
(`kubernetes-isolation.ts`). This is a **full, canonical, deep comparison of
the entire spec, labels, and annotations** — not an allowlist of fields the
launcher expects to see. An early allowlist-based version of this comparator
was replaced during implementation review specifically because an allowlist
silently accepts anything it forgot to check (lifecycle hooks,
liveness/readiness/startup probes whose `httpGet.host` can reach the node's
link-local metadata endpoint bypassing the NetworkPolicy, `procMount`,
`seLinuxOptions`, extra tolerations, `nodeSelector`, stray annotations, ...).
The only normalization applied before comparing is an explicit, narrow list
of transformations the Kubernetes API server itself is known to perform on
write/read — never a loosening of what's compared:

- Dropping `schedulerName`, `nodeName`, `priority`, `preemptionPolicy` (server-assigned).
- Dropping `hostNetwork`/`hostPID`/`hostIPC` when `false`, and an empty
  NetworkPolicy `ingress: []`, because Go's `omitempty` drops a zero-value
  bool or empty slice on serialization — a real read-back never carries
  these fields at their false/empty value, only when true/non-empty.
- Removing the mirrored `serviceAccount` field when it equals
  `serviceAccountName` (and failing closed if it doesn't).
- Removing exactly the two well-known `NoExecute` node-health tolerations
  (`node.kubernetes.io/not-ready` / `unreachable`, 300s) every pod gets by
  admission-time default — any other toleration must match exactly.
- Dropping container `terminationMessagePath`/`terminationMessagePolicy`/`imagePullPolicy`
  and probe threshold/period defaults, and normalizing CPU/memory quantities
  to a canonical millicore/byte count (so `"1"`, `"1.0"`, and `"1000m"`
  compare equal) — with a non-integer-at-that-scale value mapped to a
  sentinel that can never equal a real value, so quantity drift fails closed
  instead of rounding two different resources together.
- Dropping `mountPropagation: "None"` and an `emptyDir.medium: ""`.

Any other difference — anything not on this list — fails the launch closed
with `kubernetes_isolation_unsupported`. No fallback to a weaker profile.

### The enforcement gate

The Kubernetes API can create a NetworkPolicy object without that policy
being enforced yet — CNIs (including `kind`'s default kindnet) program a new
pod's policy a few seconds _after_ the pod starts, not atomically with pod
creation. This was found as a real, reproducible race during Task 7/8 real
-cluster testing (a hand-applied identical pod passed once it had "settled"
for ~5s, but a canary probing immediately after creation did not), and it
threatens every run, not just the harness: the worker gate could otherwise
open on a pod whose isolation isn't active yet.

The fix, before seeding or opening the worker gate: the launcher execs into
the keeper (which shares the pod's network namespace with the worker) one
`node -e` probe that measures **both of the coding proxy's ports against the
proxy Service's ClusterIP, in the same pass** — `8787` (the proxy itself, which
the run policy permits) and `8788` (the deny port, which no run policy ever
permits). Only the outcome **(8787 connected, 8788 blocked)** counts toward the
streak.

Both halves are required, and measuring only one port would be unsound. A
NetworkPolicy denial **drops** the packet rather than rejecting it — GKE
Dataplane V2 (Cilium), which Autopilot runs, always drops — so "8788 did not
answer" on its own is equally consistent with "the proxy is gone and no policy
exists at all", and a run would be released onto an unpoliced network.
Requiring 8787 to connect in the _same_ exec turns "something is listening"
from a control-plane inference (which is stale the moment it is read) into a
fact this pod just observed, at the instant of the blocked observation. The
proxy's own policy deliberately **allows** ingress on 8788 from run pods:
ingress is enforced at the destination, so denying it there would make a run
pod whose own egress policy was not yet programmed read as "blocked".

It requires **3 consecutive proven results, 500ms apart** (anything else
resets the streak — this guards against a single dropped SYN packet on an
allowed path being misread as "policy enforced"), bounded by
`enforcementTimeoutMs` (default 30,000ms — configurable via
`KubernetesJobLauncherOptions.enforcementTimeoutMs`; a drop-style CNI can
need close to this whole window). Failing to reach a proven streak in time is
`kubernetes_policy_not_enforced` — except when the _last_ probe could not
reach 8787 at all, which proves nothing about any policy and is reported
separately as `kubernetes_policy_witness_unavailable` (look at the proxy, not
at the CNI). The verdict comes from the last probe, not from whether any probe
was ever unavailable, so an early blip while the pod's networking came up does
not misdirect the operator. This wait happens inside the pod's overall
ready-timeout window, not on top of it.

`wardby coding preflight`'s canary pod waits the same way before running its
probes, for the same reason.

### Preflight

`kubernetesPreflight` / `runKubernetesPreflight`
(`src/providers/jobs/kubernetes-preflight.ts`) run **four checks in order**,
each producing `kubernetes_isolation_unsupported:<check>` on failure (or
`:timeout` if the whole preflight — cleanup included — exceeds `timeoutMs`,
default 90,000ms):

1. `namespace` — the configured namespace exists.
2. `proxy-service` — the proxy Service exists, has a ClusterIP, **exposes both
   the proxy port (8787) and the deny port (8788)**, and has at least one ready
   endpoint serving both, failing closed with
   `kubernetes_isolation_unsupported:proxy-service` otherwise. The deny port is
   the enforcement witness: a second listener on the proxy
   (`src/providers/coding-proxy/deny-port.ts`) that serves nothing and that no
   run's NetworkPolicy ever permits. A run pod that reaches 8787 but not 8788
   has proven its policy is both programmed and port-scoped. It replaces the old
   `cluster-dns` witness, which does not exist on GKE Autopilot (Cloud DNS is the
   only provider there, so no kube-dns pods run) and which made the launcher read
   `kube-system`.
3. `worker-image` — `CODING_WORKER_IMAGE` is a registry digest.
4. `canary` — creates a real run pod + NetworkPolicy from the same builders
   as a live run, running a script that waits for policy enforcement (as
   above) then attempts DNS resolution, a connect to the proxy's deny port,
   the internet (`1.1.1.1:443`), the metadata server, and the proxy itself —
   requiring every one of the first four to fail and the proxy connect to
   succeed. Any other outcome, or a canary pod that itself fails to
   schedule/run, is `kubernetes_isolation_unsupported:canary`.

This whole preflight is **memoized per launcher instance and its failure is
sticky**: `KubernetesJobLauncher.runPreflight()` caches the first call's
promise (`this.preflightResult ??= ...`, `kubernetes.ts:472-487`), including
a rejection — so once a launcher process has seen preflight fail, every
subsequent `launch()` in that process fails immediately with the same error
without re-probing the cluster. A fresh preflight requires a new process
(or, from the CLI, a fresh `wardby coding preflight` invocation, which is
not memoized).

**A hung pod create during preflight can leave a preflight pod and its
NetworkPolicy behind.** If `createPod` never settles (rather than failing),
the preflight's own timeout still fires and the caller sees `:timeout`, but
cleanup for that pod/policy is deferred to whenever the stuck create call
eventually resolves (`tracked`/`lateCleanup` in `kubernetes-preflight.ts`) —
if it never does, the objects are never removed automatically. **A canary
pod and policy are not distinguishable by name from a real run's:** both are
named `wardby-run-<runId's sha256 prefix>` (`kubernetesRunNames`,
`kubernetes-isolation.ts:90-96`, used by the preflight at
`kubernetes-preflight.ts:218,241`) and carry the same
`wardby.io/component: coding-run` label as a live run
(`kubernetes-isolation.ts:98-104,249`) — there is no
`wardby-run-preflight-*` naming pattern. After a `:timeout` failure,
operators should instead list every object with
`wardby.io/component=coding-run` in the namespace and cross-reference
against the run record ConfigMaps that legitimately exist (a stray canary
object has no corresponding non-tombstoned run record, since preflight
never creates one). Giving preflight objects a distinguishing label (e.g.
`wardby.io/component: coding-preflight`) is a tracked follow-up — see
"Known gaps" below — that would make this a direct label query instead.

### RBAC actually required

The launcher's `ClientNodeKubernetesApi` issues a narrow, specific set of
calls, and `deploy/kind-coding/manifests/base/` grants exactly that (no
`list`/`watch` on pods, no `get` on secrets — the seam never reads one
back):

- Namespace `Role` **`wardby-coding-launcher`** (in the coding namespace):
  `pods` create/get/delete, `pods/exec` create/get, `pods/log` get,
  `secrets` create/delete, `configmaps` create/get/update, `networkpolicies`
  create/get/delete, `services` get, and `endpoints` get scoped by
  `resourceNames: ["wardby-coding-proxy"]` — the one read `readProxyWitness`
  needs to prove the deny port is exposed with a ready backend. **Nothing in
  `kube-system` any more:** the old `wardby-coding-dns-reader` Role is gone
  with the `cluster-dns` check.
- `ClusterRole` **`wardby-coding-namespace-reader`**: `get` on the
  cluster-scoped `namespaces` resource, `resourceNames: [<the namespace>]`.
  This one has to be cluster-scoped — no namespaced `Role` can grant `get`
  on `namespaces` — but it's still scoped down to the one namespace via
  `resourceNames`, so the launcher identity can't discover any other
  namespace's existence.

(`deploy/kind-coding/` binds none of these to a service account — the local
harness runs every command against your own admin kubeconfig. A production
overlay, e.g. GKE, binds these two to the control plane's identity.)

**Running the real-cluster integration suite needs more than this.**
`npm run test:kubernetes` (`kubernetes.integration.test.ts`) uses a raw
`@kubernetes/client-node` client directly, alongside the launcher's own
`KubernetesApi` seam, for two things outside what the launcher itself ever
does: it reads `Endpoints` objects (`get endpoints`) to resolve kube-dns's
and the proxy pod's addresses for its isolation probes, and its cleanup
deletes each run's record ConfigMap (`delete configmaps`) — the launcher
intentionally never deletes that object (see "kept as tombstones" above), so
`deleteConfigMap` isn't even part of the `KubernetesApi` seam; the test goes
straight to the library. The committed `wardby-coding-launcher` Role grants
neither verb. On `kind` this gap is invisible because the suite runs against
the admin kubeconfig; a kubeconfig scoped to only the two launcher roles
above needs `get endpoints` (coding namespace and `kube-system`) and
`delete configmaps` (coding namespace) added before the integration suite
will pass against it.

### Diagnostics

On a failed run, the launcher reads only the failed worker container's last
8 log lines (bounded to 4096 bytes) through the Kubernetes API
(`pods/log`), and keeps only a code matching the existing
`SAFE_WORKER_DIAGNOSTIC` pattern (imported from the Docker launcher) — the
raw text itself is never stored, logged, or returned
(`readWorkerDiagnostic`, `kubernetes.ts`). This is a deliberate, narrower
replacement for the original design spec's "no `pods/log` at all"; see the
spec corrections below. A later milestone has the worker write a structured
`diagnostic.json` instead, which the launcher will prefer once it exists —
not implemented yet.

### Known gaps / follow-up plan (Plan 2b)

- **No gVisor / per-pod process (PID) limit on `kind`.** `kind` has no
  runtime-class sandboxing; `KUBERNETES_RUNTIME_CLASS` is unset in the local
  harness and the launcher logs `kubernetes_runtime_class_unset` once per
  launch as a loud "development cluster" warning. GKE Autopilot's `gvisor`
  runtime class (Plan 3) is the real mitigation.
- **Claude Code is not implemented on Kubernetes** — refused with
  `kubernetes_provider_unsupported` (Plan 2b).
- **Spec §9's integration coverage is only partially implemented.** What
  Task 8 proved on a real `kind` cluster: the contract suite against the
  real API, the enforcement gate genuinely gating (not just unit-tested),
  and a full run lifecycle including the `storage-init` fix. **Not yet
  implemented** (tracked as a Plan 2b follow-up): the isolation acceptance
  suite's OOM/disk-full/wall-clock containment assertions, "canary fails
  when a policy is removed", and "the tool pod has no network" (moot for
  Codex's single-pod layout; relevant once Claude Code's two-pod layout
  ships).
- **No end-to-end backpressure or host-side archive-size cap** once the
  exec WebSocket for a seed/collect transfer is connected — pre-existing,
  documented, not a regression of this milestone.
- **An over-ceiling `workspaceDiskMb` fails late and generically** — see
  "Control Plane Configuration" above.
- **`kind` harness namespace quirk to preserve in any new overlay** (e.g. a
  future GKE overlay): `deploy/kind-coding/manifests/base/kustomization.yaml`
  deliberately has **no top-level `namespace:` override**, because
  kustomize's namespace transformer would force `metadata.namespace` onto
  every namespaced resource it lists. Every manifest instead sets its own
  `metadata.namespace` explicitly. Any overlay author copying this harness for
  another cluster must do the same.
- **Per-run record ConfigMap GC is unimplemented.** Both `remove()`'s
  deliberate tombstones and a failed launch's records (see above)
  accumulate forever, one small ConfigMap per run, with nothing that ever
  deletes them. Needed before a long-lived production deployment; not a
  correctness or security issue, an operational one (etcd growth).
- **Autopilot attestation allowances are not yet modeled.** Attestation
  compares the read-back pod annotations and resource quantities exactly;
  GKE Autopilot is known to add its own annotations and to round
  requests/limits, so as shipped, Autopilot will fail every attestation.
  Plan 3 needs an explicit, narrow allowance list for whatever Autopilot is
  confirmed to add/round, following the same "only what the platform is
  known to do" discipline as the existing server-default normalization.
- **A distinguishing label for preflight/canary objects.** Canary pods and
  policies are currently named and labeled identically to real run objects
  (`wardby.io/component: coding-run`), which is why the troubleshooting
  guidance above can only recommend cross-referencing against run records
  rather than a direct label query. Giving preflight objects their own
  `wardby.io/component: coding-preflight` label would fix this and would
  also let a future orphan reaper (the ConfigMap GC item above, extended to
  pods) tell a canary apart from a live run.
- **The real-cluster integration suite still uses the deprecated core/v1
  `Endpoints` API** (`kubernetes.integration.test.ts`) rather than
  `discovery.k8s.io/v1` `EndpointSlice`. `Endpoints` is deprecated, not yet
  removed, and this is test-only code, but the migration is a tracked
  follow-up rather than something to re-discover later.

### Troubleshooting: failure codes

| Code                                                                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubernetes_isolation_unsupported:<check>`                                   | A preflight check failed; `<check>` is one of `namespace`, `proxy-service`, `worker-image`, `canary`. Sticky for the launcher's process lifetime once seen (see Preflight above).                                                                                                                                                                                                                                                                                                                                                           |
| `kubernetes_isolation_unsupported:timeout`                                   | The whole preflight (including cleanup) exceeded its timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `kubernetes_isolation_unsupported`                                           | (No suffix) Attestation failure: the read-back pod or NetworkPolicy didn't canonically match the builder's output.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `kubernetes_policy_not_enforced`                                             | The run's NetworkPolicy wasn't observed enforced (8787 reachable, 8788 blocked) within `enforcementTimeoutMs`; the worker gate was never opened.                                                                                                                                                                                                                                                                                                                                                                                            |
| `kubernetes_policy_witness_unavailable`                                      | The last enforcement probe could not reach the proxy on 8787 at all, so nothing could be witnessed — the proxy or its Service is the thing to check, not the CNI. The worker gate was never opened.                                                                                                                                                                                                                                                                                                                                         |
| `kubernetes_proxy_witness_unusable: <reason>`                                | The proxy Service is not a usable enforcement witness (missing, no ClusterIP, a required port not exposed as TCP, or no ready endpoint serving both 8787 and 8788). Seen **unwrapped** like this only from `provision`'s per-launch re-read, which runs after a supplied `preflight` has already passed; the launcher's own memoized read reports the same condition wrapped as `kubernetes_isolation_unsupported` (with this string on `cause`), and the preflight reports it as `:proxy-service`. Fails closed before the pod is created. |
| `kubernetes_pod_start_timeout`                                               | The keeper didn't become ready within `readyTimeoutMs` (default 120s). Historically caused by the subPath root-ownership issue the `storage-init` init container now fixes; if seen again, check init-container status first.                                                                                                                                                                                                                                                                                                               |
| `kubernetes_pod_start_failed`                                                | The pod (or its `storage-init` init container) failed outright rather than timing out.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `kubernetes_provider_unsupported`                                            | The job spec asked for `claude-code`, which this launcher doesn't implement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kubernetes_seed_failed`                                                     | Streaming the workspace or input artifact into the keeper failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `kubernetes_workspace_archive_failed` / `kubernetes_result_artifact_invalid` | Collection (workspace or output artifact) failed or was invalid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `coding_workspace_disk_exceeds_limit`                                        | The run's `workspaceDiskMb` exceeds `CODING_MAX_DISK_MB`; surfaces on the run record as `coding_failure_workspace:<id>`.                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Local harness

`deploy/kind-coding/` stands up a local `kind` cluster (with a local image
registry so images are pulled by digest, as on GKE) that proves this
launcher end to end, including real NetworkPolicy enforcement. See
[`deploy/kind-coding/README.md`](../deploy/kind-coding/README.md) for
prerequisites, the up/down scripts, and what each step does.

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
