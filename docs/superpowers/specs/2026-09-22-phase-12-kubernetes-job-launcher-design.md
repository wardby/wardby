# Phase 12: Kubernetes Job Launcher for Coding Agents — Design

**Date:** 2026-09-22
**Status:** Proposed (design approved section by section in brainstorming;
implementation plan to follow via writing-plans)
**Author:** wardby maintainer
**Related:** `docs/private/2026-09-21-phase-12-kubernetes-job-launcher-brief.md`
(options, cost estimate, why Kubernetes over Cloud Run Jobs);
`docs/coding-worker-isolation.md` (the Docker isolation model this design
must preserve or exceed); `src/providers/jobs/types.ts` (the `JobLauncher` /
`WorkspaceJobLauncher` contract); `src/providers/jobs/docker.ts`,
`src/providers/jobs/docker-isolation.ts` (the launcher and policy builder
this mirrors); `src/providers/executor/container.ts` (`ContainerExecutor`);
`src/providers/vcs/git.ts` (clone and finalization);
`docs/superpowers/specs/2026-09-17-gcp-control-plane-hosting-design.md`
(the Cloud Run control plane this attaches to).

> **Clean-room note.** Grounded in wardby's own code and docs listed above
> plus the public Kubernetes API and Google Cloud documentation. Copies no
> external codebase. Where this spec depends on a platform behavior that was
> not verified against the provider's own documentation during design, it is
> marked **(verify)** and the implementation plan must confirm it from the
> official docs before relying on it.

---

## Corrections after implementation (2026-09-22)

This section does not rewrite the history above — the body text below still
describes the original design, edited only where it was factually wrong
about what shipped. This section is the complete, dated list of every place
implementation diverged from this design, and why, decided during
implementation planning and code review (see the SDD ledger,
`.superpowers/sdd/2026-09-22-phase-12-kubernetes-launcher-codex/progress.md`,
for the full review trail behind each one). Five were binding corrections
made before implementation started (global constraints); the rest were
rulings made during implementation review, mostly in response to a real
failure mode a reviewer or a real cluster surfaced.

**Binding corrections made before implementation (Global Constraints):**

1. **Diagnostics (§7, §8.1).** Replacing "no `pods/log`": the control plane
   reads only a failed worker container's last 8 log lines (≤4096 bytes)
   through the Kubernetes API and keeps only a code matching the existing
   `SAFE_WORKER_DIAGNOSTIC` pattern; the raw text is never stored, logged,
   or returned. A later milestone has the worker write `diagnostic.json`
   instead, which the launcher will prefer once it exists (not yet).
2. **Extractor symlink rule (§4).** In-tree symlinks are allowed (matching
   today's `validateMaterializedWorkspace`, which already allows them for
   the Docker launcher); the extractor rejects any entry whose path passes
   through an already-extracted symlink, plus absolute paths, `..`, hard
   links, and device/fifo/other special entries. Replaces "rejects
   symlinks".
3. **State (§3).** Job state lives in a per-run record ConfigMap and a
   per-run capability Secret; the deadline is also enforced by the pod's
   `activeDeadlineSeconds` as a backstop. No local state files, no
   in-process timers.
4. **Proxy addressing (§5).** Workers keep `WARDBY_PROXY_URL=http://wardby-proxy:8787`
   (`CODING_PROXY_ALIAS`, the same alias the Docker launcher uses — distinct
   from the `KUBERNETES_PROXY_SERVICE` Kubernetes Service name,
   `wardby-coding-proxy` by default; the proxy checks the `Host` header); the
   pod maps that alias to the proxy Service's ClusterIP with `hostAliases`,
   so no DNS is needed at all.
5. **Start gate (§3).** The worker container's command is overridden to
   wait for a seeded marker file before importing the real entrypoint,
   rather than using a native sidecar — Kubernetes terminates sidecars when
   the pod's main container exits, which would kill the keeper before
   result collection.

**Corrections made during implementation review (code review findings and
real-cluster testing):**

6. **Attestation is deny-by-default, not an allowlist (§5).** An early
   allowlist-based comparator was replaced with a full, canonical,
   deep-equality comparison of the entire pod spec / NetworkPolicy spec,
   labels, and annotations, because an allowlist silently accepts anything
   it forgot to check — review found it missed lifecycle hooks, probes
   whose `httpGet.host` could reach the node metadata endpoint, several
   security-context fields, tolerations, and more. Only an explicit,
   narrow list of server-side defaulting/serialization behaviors (Go
   `omitempty` dropping zero-value fields, default tolerations, quantity
   unit normalization, etc.) is normalized before comparing.
7. **A `storage-init` init container was added to the pod (§3, §5).**
   Real-cluster testing found every run failing
   `kubernetes_pod_start_timeout`: kubelet creates a subPath mount's target
   directory root-owned the first time it sets up the worker's volume
   mounts, and the keeper (uid 10001, no Linux capabilities) cannot `chmod`
   a directory it doesn't own. The init container pre-creates
   `workspace`/`input`/`output` (uid 10001, mode 0700) before any regular
   container starts, so kubelet finds them already owned. It is attested in
   full like every other container.
8. **The NetworkPolicy enforcement gate (§5) was added mid-implementation**
   after real-cluster testing reproduced a startup race: CNIs (including
   `kind`'s kindnet) program a new pod's NetworkPolicy a few seconds after
   the pod starts, not atomically with pod creation, so a worker gate that
   opened immediately after attestation could run briefly unpoliced. Both
   the launcher (before opening the worker's start gate) and the preflight
   canary (before running its probes) now wait for a TCP connect to the
   cluster DNS Service's ClusterIP to be blocked on 3 consecutive attempts,
   500ms apart, within a bounded timeout, before proceeding.
9. **The canary gained a fifth probe, `clusterDns` (§5), during review**,
   because the original DNS/internet/metadata/another-pod probe list, as
   specified, could pass on a non-enforcing CNI: the DNS and internet/
   metadata probes are unreachable regardless of policy enforcement on
   `kind`/air-gapped/on-prem clusters, so an additive allow-DNS policy
   would go undetected. `clusterDns` (a direct TCP connect to the kube-dns
   Service's ClusterIP — kube-dns backends are ordinary pods, so only a
   NetworkPolicy blocks it) is the design's "another pod" probe, and is
   the one that actually proves enforcement.
10. **RBAC (§7) is three roles, not the "pods (create, get, list, watch,
    delete)" set originally sketched.** `list`/`watch` on pods were dropped
    (the seam only ever addresses one named pod at a time; least privilege
    beats an unused grant); `pods/log` was added (correction 1); a
    `configmaps` grant was added (the per-run record); and the namespace
    read the preflight needs is cluster-scoped (`get namespaces`, no
    namespaced `Role` can grant it), so it is a separate `ClusterRole`
    scoped to the one namespace by `resourceNames`, plus a `kube-system`
    `Role` scoped to the `kube-dns` Service by `resourceNames` for
    correction 9's probe. See `docs/coding-worker-isolation.md`'s
    Kubernetes launcher section for the exact three roles and their verbs.
11. **Per-run record ConfigMaps are never deleted, by design (§3, §7).**
    `remove()` deletes the pod, NetworkPolicy, and capability Secret, but
    intentionally rewrites the record to a `removed` tombstone instead of
    deleting it, because the contract is that a removed run is never
    relaunched and the record is what a later `launch()` call checks. This
    was flagged as an open question during review: nothing garbage-collects
    old tombstones today, so they accumulate — one small ConfigMap per run,
    forever — and a GC follow-up is needed.
12. **The `kind` harness's kustomize base has no top-level `namespace:`
    override (§7).** Kustomize's namespace transformer forces
    `metadata.namespace` onto every namespaced resource it lists, which
    would relocate the `kube-system` DNS-reader `Role` (correction 10) into
    the coding namespace and break it. Every manifest sets its own
    `metadata.namespace` instead. Any future overlay (e.g. GKE, Plan 3)
    reusing `manifests/base/` must do the same.
13. **Spec §9's integration coverage is only partially implemented.** What
    shipped on a real `kind` cluster: the contract suite against the real
    API, the enforcement gate (correction 8) genuinely proven end to end,
    and a full run lifecycle including correction 7's fix. Not yet
    implemented, and out of this milestone's scope: the isolation
    acceptance suite's OOM/disk-full/wall-clock containment assertions,
    "canary fails when a policy is removed", and "the tool pod has no
    network" (moot until Claude Code's two-pod layout ships). Tracked as a
    Plan 2b follow-up alongside Claude Code support itself.
14. **This corrections section itself had the proxy hostname wrong (final
    review finding I4, 2026-09-22).** Correction 4 above and §5's body text
    both originally repeated `WARDBY_PROXY_URL=http://wardby-coding-proxy:8787`
    — the Kubernetes Service name (`KUBERNETES_PROXY_SERVICE`), not the
    `hostAliases` alias the pod actually resolves. The real value is
    `http://wardby-proxy:8787` (`CODING_PROXY_ALIAS`,
    `kubernetes-isolation.ts:185,224`; `docker-isolation.ts:8`) — the same
    alias the Docker launcher has always used. The implementation plan had
    this right throughout; only this spec's corrections record (the
    document meant to be authoritative about what shipped) was wrong, which
    is corrected in place above and in §5.

## 1. Goal and non-goals

**Goal.** Run Codex and Claude Code coding agents on a hosted deployment, at
scale, with isolation at least as strong as today's Docker model. Coding
runs execute as Kubernetes pods; the control plane (Cloud Run or any host)
drives them through the standard Kubernetes API. The first target is GKE
Autopilot behind the `deploy/gcp` control plane; the same launcher serves
EKS, AKS, on-prem Kubernetes, and a local `kind` cluster.

**Why.** Today coding agents run only where a Docker daemon is available to
the control-plane process. Cloud Run has none, so a hosted deployment can run
every agent kind except coding agents, and a coding run fails closed
(`JOB_LAUNCHER=local`). The Docker launcher also cannot scale beyond one host.

**First milestone scope (decided):** both providers, full isolation. Codex
and Claude Code run through the new launcher, network policies are enforced
and tested, Claude Code's tool pod is isolated, and each run can open a draft
PR.

**Non-goals (this milestone):**

- Cloning inside the cluster, and moving the Git finalizer into the cluster.
  The finalizer commits from a trusted control-plane checkout, so an
  in-cluster clone alone would not remove the control plane's copy; the real
  gain requires moving finalization (and a write-capable GitHub token) into
  the cluster, a trust-boundary redesign that needs its own design and review.
- Copying back only changed files. An optimization, not a correctness issue;
  it needs trusted-side change detection.
- A native ECS launcher. AWS uses this launcher on EKS.
- Changing the Docker launcher's behavior. It remains supported and its tests
  must keep passing.

## 2. Architecture

The control plane keeps its current responsibilities end to end;
**only the Docker-facing part is replaced.** `ContainerExecutor`, proxy
sessions, the Git finalizer, workspace validation, recovery, and cleanup are
unchanged. A new `KubernetesJobLauncher` implements `WorkspaceJobLauncher`,
exactly as `DockerJobLauncher` does.

**Components:**

- **Control plane** (MCP server, scheduler, `ContainerExecutor`, finalizer).
  New: `KubernetesJobLauncher`, selected by `JOB_LAUNCHER=kubernetes`; a
  database-backed concurrency gate in `ContainerExecutor` (§6).
- **One namespace per deployment** (default `wardby-coding`), containing:
  - the **coding proxy** as a Deployment + Service, the only workload with
    internet egress, holding the model credentials, with database access;
  - **per-run pods** (§3);
  - **per-run network policies** plus namespace-wide default-deny, and a
    `ResourceQuota` as a backstop.

**Run flow:**

1. Trigger → concurrency slot claimed, or the run queues (§6).
2. Shallow clone on the control plane (§4) → create the workspace pod →
   stream the workspace and input artifact in through the Kubernetes API.
3. Create the worker pod(s) and network policies → attest the effective specs
   (§5) → start.
4. Watch to terminal → collect the output artifact and, for `changes_ready`,
   the workspace.
5. Validate → finalizer commits, pushes, and opens a draft PR → remove every
   run resource.

**Control plane → cluster authentication.** On GKE, the control plane
authenticates as its Google service account; namespace-scoped Kubernetes RBAC
grants only what the launcher needs (§7). Locally, a kubeconfig. The launcher
uses only the standard Kubernetes API, so clusters differ in configuration
and Terraform, not code.

**Configuration.** `JOB_LAUNCHER=kubernetes` replaces the reserved, unused
`"ecs"` value in `JobLauncherKind` (`src/config/providers.ts`). New settings
(names finalized in the plan): namespace, cluster connection (in-cluster,
kubeconfig, or GKE endpoint), required runtime class, and digest-pinned
images for the Codex worker, Claude agent, Claude tool runner, and keeper.

## 3. Launcher and pod layout

**Keeper placement.** An `emptyDir` volume belongs to one pod and cannot be
mounted by another, so Docker's shared keeper volume does not map one-to-one.
Rather than introduce persistent volume claims, **the keeper is a regular
container inside the pod that owns the workspace** — not an init container
and not a native sidecar. Its role is unchanged: it holds the volume, is the
target for streaming files in and out, and keeps running after the worker
exits so results can be collected.

**Worker start gate.** A pod's containers all start together — Kubernetes
has no "start this container after that one" — so the worker cannot simply
be launched later the way Docker's is. A native sidecar container (`restartPolicy:
Always` at the container level) cannot substitute: Kubernetes terminates
sidecars when the pod's main container exits, which would kill the keeper
before result collection. Instead the worker container's own command is
overridden to wait for a seeded marker file
(`/run/wardby/input/.seeded`) before importing the image's real entrypoint;
the launcher writes that marker (through the keeper) only after the pod and
its NetworkPolicy have been read back and attested against the canonical
builders (§5), the policy has been observed enforced, and the workspace and
input have been seeded. Until the marker exists, nothing untrusted runs.

**Codex: one pod, two containers** (`keeper`, `worker`) plus one init
container (`storage-init`, §5), sharing one volume with today's four areas:
`/workspace` read-write, input read-only, output read-write, and no Git
metadata (it stays on the control plane). Egress is limited to the proxy.

**Claude Code: two pods**, preserving today's credential separation:

- **Workspace pod:** `keeper` + `tool`. Mounts the repository. No internet and
  no proxy access. Accepts only the relay connection from its own agent pod.
- **Agent pod:** `agent` only. Does not mount the repository. May reach only
  the proxy and its tool pod's relay port.
- **Relay:** moves from a Unix socket to TCP between the two pods, permitted
  only by network policy and authenticated with a random per-run token so
  nothing else in the namespace can use it. The launcher supplies the tool
  pod's address to the agent; neither side takes it from untrusted input.

**Contract mapping** (the invariants documented in `types.ts`):

| Method                 | Behavior                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch`               | Resource names derive from the run ID, so a repeated launch for an identical spec converges on the existing resources; a different spec for the same run ID is rejected. Handle: `{ backend: "kubernetes", id: "<namespace>/<run>" }`. |
| `status`               | From pod and container states, including exit codes, OOM kills, and image-pull failures. Terminal states never change.                                                                                                                 |
| `collect`              | Reads the output artifact through the keeper, bounded by today's artifact size limit. Repeatable until `remove`.                                                                                                                       |
| `materializeWorkspace` | Streams the workspace out through the keeper into control-plane staging (§4), then runs today's validation.                                                                                                                            |
| `stop`                 | SIGTERM, then kill after the grace period. Idempotent, best effort.                                                                                                                                                                    |
| `remove`               | Deletes every resource labeled for the run (pods, network policies, the per-run Secret). Refuses while the run is active. Idempotent.                                                                                                  |

No operation relaunches a missing, stopped, or removed job.

**Storage.** The workspace volume is disk-backed (node ephemeral storage, not
`medium: Memory`), sized per agent (§4). `/tmp` and the home directory stay
small RAM-backed volumes.

**Images.** Pinned by digest and pulled from a registry (Artifact Registry on
GKE, a local registry beside `kind`).

## 4. Workspace transfer and large repositories

**Clone (control plane, shared VCS code in `vcs/git.ts`).** Add `--depth 1`
to today's `--no-checkout --single-branch --no-tags` clone. Revision-in-place
continuations clone the existing branch at depth 1. The Docker launcher
benefits too. **The plan must verify** that the finalizer's pre-push checks
(branch ancestry, "remote has not moved") work with depth-1 history; where a
check needs more, deepen the clone just enough rather than drop the check.

**Seeding (control plane → keeper).** The control plane creates a tar of the
checked-out tree and streams it through the Kubernetes exec API into the
keeper, which extracts it into `/workspace`. The input artifact goes into the
read-only input area the same way. The keeper runs the same digest-pinned
worker image as the untrusted worker container (no separate keeper image is
introduced — the trust boundary is the entrypoint the launcher chooses, not
a distinct image: the keeper's command is `keeper.js`, a small extract/archive
role, while the worker's is the coding agent's real entrypoint, exactly as
the existing Docker launcher already does). Streaming uses the official
client (`@kubernetes/client-node`), with timeouts bounded by the full run
timeout rather than a shrinking remaining-deadline budget, because
collection can legitimately happen after a run's own deadline has passed.

**Collecting (keeper → control plane).**

- Output artifact: bounded read; anything over the existing artifact limit
  fails the run.
- Workspace (only for `changes_ready`, as today): the keeper streams a tar;
  the control plane extracts it with a **strict extractor** that rejects
  absolute paths, `..` components, hard links, device and other
  special entries, and enforces byte and entry limits while streaming.
  **In-tree symlinks are allowed** (today's `validateMaterializedWorkspace`
  already allows them for the Docker launcher, so refusing them here would
  be a new, narrower restriction the extractor has no reason to introduce);
  what the extractor rejects is any entry whose path passes through an
  already-extracted symlink, plus the absolute/`..`/hard-link/special-entry
  cases above. Then the existing `validateMaterializedWorkspace` runs
  unchanged (special files, nested `.git`, escaping symlinks, size limits,
  protected paths).

**Limits.** A new per-agent volume size in the coding profile (default 2 GiB,
today's `CODING_DISK_MB` default) bounds the workspace both ways. The existing
100,000-entry limit and diff limits (1,000 files / 1 MiB) are unchanged in
this milestone.

## 5. Isolation and attestation

A canonical policy builder, `kubernetes-isolation.ts` (mirroring
`docker-isolation.ts`), produces every pod spec and network policy; nothing
else constructs them.

**Every coding pod:**

- UID/GID `10001`, `runAsNonRoot`, `allowPrivilegeEscalation: false`, all
  capabilities dropped (including `NET_RAW`), seccomp `RuntimeDefault`,
  read-only root filesystem.
- `automountServiceAccountToken: false` and a dedicated service account with
  no RBAC permissions: workers cannot reach the Kubernetes API.
- No host network, PID, or IPC; no host paths; `enableServiceLinks: false`.
- CPU and memory requests equal to limits. Disk is not expressed as an
  `ephemeral-storage` resource request/limit; it is bounded by the storage
  volume's `emptyDir.sizeLimit` (disk-backed, not `medium: Memory`), sized
  from the per-agent `workspaceDiskMb`/`CODING_DISK_MB` limit. The wall-clock
  deadline is enforced by the launcher (with `activeDeadlineSeconds` set to
  `timeoutSec` plus a fixed grace period as a backstop only, so the keeper
  survives long enough for result collection after a worker is killed at its
  deadline).
- `runtimeClassName: gvisor` **required on GKE**. On `kind` there is no
  gVisor; the launcher logs a loud "development cluster: no gVisor" warning
  and the deployment is treated as development-only.
- The run capability is delivered through a per-run Secret referenced as an
  environment variable, never in the pod spec or arguments, and deleted in
  `remove`.

**Network policies (namespace default-deny for ingress and egress):**

| Pod                                  | Egress allowed                                                                            | Ingress allowed                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Codex worker, Claude agent           | Proxy pods, proxy port only                                                               | None                           |
| Claude workspace pod (tool + keeper) | None                                                                                      | Own agent pod, relay port only |
| Proxy                                | Internet on 443 excluding private, loopback, link-local and metadata ranges; the database | Worker and agent pods          |

**DNS is denied to worker and agent pods.** The pod sets `dnsPolicy: None`
with `dnsConfig.nameservers: ["127.0.0.1"]` (a loopback address nothing
listens on, so any resolution attempt fails), so there is no resolver
configured at all — DNS is not merely blocked by the NetworkPolicy, it has
nothing to reach. The proxy is still addressed by its Docker-launcher-era
alias (`WARDBY_PROXY_URL=http://wardby-proxy:8787`, `CODING_PROXY_ALIAS`;
distinct from `KUBERNETES_PROXY_SERVICE`, the Kubernetes Service name
`wardby-coding-proxy`; the proxy checks the `Host` header), which resolves
without DNS because the pod's `hostAliases` maps `wardby-proxy` directly to
the proxy Service's ClusterIP (read once by the launcher before the pod is
created). This closes DNS as an exfiltration channel and matches today's
"no custom DNS" rule while letting the worker keep the same proxy URL
Docker runs use.

**Attestation, fail closed.**

- _Before start:_ read back every created pod and policy and compare them
  against the builder's output with a **deny-by-default, canonical, full
  comparison** of the entire spec, labels, and annotations (recursively
  key-sorted for a stable comparison) — not an allowlist of fields expected
  to matter. Only an explicit, narrow list of transformations the
  Kubernetes API server itself is known to perform on write/read is
  normalized first (dropped server-assigned fields; `omitempty`-dropped
  zero-value booleans and empty slices; the two default node-health
  tolerations; quantity-unit normalization; probe/container defaults),
  including the runtime class actually applied (Autopilot may mutate pods).
  Any other difference at all fails the run with the fixed code
  `kubernetes_isolation_unsupported`. No fallback to a weaker profile, as
  today. (An earlier allowlist-based comparator was replaced during
  implementation review because an allowlist silently accepts anything it
  forgot to check.)
- _Enforcement:_ the API cannot show whether network policies are enforced,
  and CNIs (including `kind`'s default kindnet) program a new pod's policy a
  few seconds _after_ the pod starts, not atomically with pod creation — a
  real, reproducible race found during implementation. Two mechanisms:
  - `wardby coding preflight`'s five checks (namespace, proxy Service,
    cluster DNS Service, worker image is a registry digest, and the canary)
    build a real run pod and NetworkPolicy from the same builders as a live
    run; the canary script first waits (up to 20s) for a TCP connect to the
    cluster DNS Service's ClusterIP — an ordinary pod, so only the
    NetworkPolicy can block it — to be blocked before running its actual
    probes: in-pod DNS resolution, that same cluster-DNS connect, the
    internet, and the metadata server must all fail, and a connect to the
    proxy must succeed. Any other outcome fails closed. The whole preflight
    is memoized per launcher process and a failure is sticky: once seen, it
    is not retried without a new process.
  - The launcher itself, on every launch (not just once at startup, and
    always before the worker's start gate opens — see §3): execs into the
    keeper to attempt the same cluster-DNS TCP connect, and requires three
    consecutive blocked results 500ms apart (any success resets the count)
    within a bounded timeout. Only then is the seeded marker written and the
    worker allowed to start.
    If enforcement is never observed, coding execution for that run (or, for
    the preflight, the whole launcher) stays disabled.

**Known gap.** Kubernetes has no per-pod process limit that Autopilot lets
tenants set **(verify)**. gVisor is the mitigation; the adversarial suite
measures fork-bomb containment and records the result. The gap is documented,
not hidden.

## 6. Concurrency and queueing

Lives in `ContainerExecutor`, so Docker-host deployments get it too.

**Configuration.** `CODING_MAX_CONCURRENT` (positive integer, default 4) caps
coding runs holding a slot, across every control-plane replica.
`CODING_QUEUE_TIMEOUT_SEC` (default 3600): a run queued longer fails with
the fixed reason `coding_queue_timeout`.

**Claiming a slot** (first step of `start`, before any clone or pod). One
transaction takes an advisory lock, counts coding runs that hold a slot and
are not terminal, and marks this run as holding one if under the cap;
otherwise the run stays `pending`, marked queued. Slot usage is **derived
from run state**, not a separate counter: a run that finishes, fails, is
stopped, or is reconciled to `lost` stops counting, so a crashed replica
cannot leak slots. Correctness across replicas comes from the database, as
with the scheduler's claim (`scheduler.ts`), never from process memory.

**Starting queued runs.** The scheduler tick (lease holder only) claims slots
for the oldest queued coding runs, oldest first, and starts them through the
executor. A finishing run also attempts an immediate start in its own
process, so freed slots are usually reused within seconds rather than the
next tick.

**Budgets.** The pre-flight budget check runs before queueing (a run that
would be refused never waits) and again at start.

**Visibility.** `get_run` / `list_runs` show a queued run as `pending` with a
`queued` coding phase and its enqueue time.

**Multiple deployments on one cluster.** Each deployment has its own namespace
and cap; the namespace `ResourceQuota` bounds total CPU, memory, and storage
regardless of run count. Wardby's cap counts runs; the quota bounds resources.

**Schema change.** New nullable columns on `CodingRun` (slot claimed at,
queued at) and an index supporting "oldest queued". Per CLAUDE.md: a
hand-written additive migration, matching `@@index` declarations, and a clean
drift check, in the same change.

## 7. Deployment

**One set of manifests, two overlays.** Namespace, control-plane RBAC, proxy
Deployment/Service/service account, default-deny policies, and the
`ResourceQuota` are plain manifests with kustomize overlays for `kind` and
GKE, applied with `kubectl`. Terraform owns cloud infrastructure; the
manifests own in-cluster objects. EKS later adds an overlay. Deploys stay
manual and documented (no CI/CD).

**Local harness: `deploy/kind-coding/`** (in the style of
`deploy/keycloak-test/`):

- A `kind` cluster config with a policy-enforcing network layer. First verify
  whether `kind` 0.33's default network layer enforces NetworkPolicy
  **(verify)**; if not, the config installs Calico. The preflight canary
  proves enforcement either way.
- A local registry beside the cluster, so images are pulled by digest as on
  GKE.
- Up/down scripts: create cluster and registry, push images, apply the
  overlay.
- The control plane runs on the host (`wardby serve`) with a kubeconfig; the
  proxy runs in-cluster and reaches local Postgres via `host.docker.internal`.

Standalone `kind` is used rather than Docker Desktop's built-in Kubernetes:
Docker Desktop's kind mode requires switching to the containerd image store,
which would hide the existing worker images and invalidate the pinned image
IDs the Docker launcher uses.

**GKE in `deploy/gcp`: optional, off by default** (e.g.
`enable_coding_cluster = false`), like Cloud Armor. When enabled:

- A regional GKE Autopilot cluster with GKE Sandbox available **(verify
  availability and pricing on Autopilot)**.
- The cluster's DNS-based API endpoint with Google IAM authentication, so the
  Cloud Run control plane connects without IP allowlists (Cloud Run egress
  addresses are not fixed) **(verify)**.
- The control plane's service account gets only the cluster-level role needed
  to connect; namespace permissions come from the manifests' RBAC bound to
  that identity, split across three roles (`deploy/kind-coding/manifests/base/`,
  reused unbound by the GKE overlay): a namespace `Role`
  (`wardby-coding-launcher`) granting pods create/get/delete (not list/watch
  — the seam only ever addresses one named pod), `pods/exec` create/get,
  **`pods/log` get**, secrets create/delete (not get — the seam only ever
  writes or deletes the capability Secret, never reads one back), configmaps
  create/get/update (the per-run record), and networkpolicies create/get/
  delete; a `kube-system` `Role` (`wardby-coding-dns-reader`) granting `get`
  on the `kube-dns` Service only; and a `ClusterRole`
  (`wardby-coding-namespace-reader`) granting `get` on the one namespace by
  `resourceNames` (the preflight's namespace check is a cluster-scoped read
  that no namespaced `Role` can grant). **`pods/log` is required**, narrowly:
  §8 replaces the original "no `pods/log`" design with reading only a
  failed worker's last 8 log lines (≤4096 bytes) and keeping only a code
  matching a fixed pattern — see the corrections below.
- A Workload Identity binding so the proxy's Kubernetes service account
  reaches Cloud SQL through Google's connector and reads model API keys from
  Secret Manager **(verify the Autopilot-supported Secret Manager
  integration)**.
- Control-plane settings: `JOB_LAUNCHER=kubernetes`, namespace, cluster
  endpoint, digest-pinned images.
- The Cloud Logging exclusion for worker, agent, and tool output, and the
  opt-in restricted debug bucket (§8.1).
- `SETUP.md` additions: building and pushing worker images to Artifact
  Registry, applying the GKE overlay, `wardby coding preflight`, the added
  cost (cluster fee plus pods; see the brief), and teardown order (namespace,
  then cluster).

## 8. Error handling

- Fixed, sanitized failure categories, consistent with today's
  `failureCategory`: `kubernetes_isolation_unsupported` (attestation or
  preflight failure), `coding_queue_timeout`, image-pull failure, OOM,
  deadline exceeded, workspace limit exceeded, extractor rejection. No raw
  pod logs, task text, repository content, or credentials in errors or
  events.
- Provisioning ambiguity (a proxy session without a persisted job handle) is
  handled exactly as today: never relaunched, reconciled to `lost`, cleaned up
  from the persisted handle.
- Kubernetes API errors during `remove` are retried idempotently; resources
  are found by run label, so partial cleanup converges.

### 8.1 Raw logs and debugging

Worker output is untrusted: it can contain repository contents, model output,
and anything a malicious repository chooses to print. Two rules follow.

**The control plane never stores or returns raw pod output**, even though it
does hold `pods/log` (§7) — the original "no `pods/log` at all" design was
replaced during implementation planning (binding correction, see below):
on a failed run the launcher reads only that worker container's last 8 log
lines (bounded to 4096 bytes) and keeps only a code matching the existing
fixed `SAFE_WORKER_DIAGNOSTIC` pattern; the raw text itself is discarded in
process and never stored, logged, or returned. Only that fixed,
worker-owned diagnostic code reaches run records, events, and `get_run`,
exactly as with the Docker launcher. This keeps raw output out of the
MCP-facing process, which any authorized MCP user can query. (A later
milestone has the worker write a structured `diagnostic.json` instead,
which the launcher will prefer once it exists; not implemented yet.)

**Raw output is not retained by default.** On GKE, container output is sent
to Cloud Logging unless something stops it. The `deploy/gcp` module adds a
Cloud Logging **router exclusion filter** that discards entries from the
coding namespace's `worker`, `agent`, and `tool` containers before they are
stored (excluded entries are also not billed). It is a project-level router
rule, so it applies regardless of cluster mode, including Autopilot
**(verify the exact filter fields for GKE container logs)**.

| Source                                  | Stored in Cloud Logging | Reason                                                           |
| --------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| Codex worker, Claude agent, Claude tool | No (excluded)           | Untrusted output                                                 |
| Keeper                                  | Yes                     | Trusted; prints only its own status                              |
| Coding proxy                            | Yes                     | Trusted; already sanitized (metadata only, no prompts or bodies) |
| Control plane                           | Yes                     | Unchanged; already sanitized                                     |
| Kubernetes / GKE system logs            | Yes                     | Scheduling, OOM kills, image pulls; not sensitive                |

**How operators debug:**

1. **While a pod exists:** `kubectl logs` with the operator's own cluster
   credentials reads output directly from the node. The router exclusion does
   not affect this path.
2. **Debug window for failures:** `CODING_RETAIN_FAILED_SEC` (default `0`,
   i.e. off) keeps a failed run's pods for that many seconds before `remove`,
   so there is time to inspect them. The run's concurrency slot is released at
   its terminal state as usual (§6); retained pods still count against the
   namespace `ResourceQuota`, which bounds how much a burst of failures can
   hold. The reconciler removes retained pods once the window ends, including
   after a control-plane restart.
3. **Opt-in debug routing:** a Terraform variable (e.g.
   `coding_worker_logs = "debug"`, default `"drop"`) replaces the exclusion
   with a sink routing worker, agent, and tool output to a **separate log
   bucket with short retention (e.g. 3 days) and access restricted to
   operators**, never the project's default bucket. Operators switch it back
   when finished.

**Trade-off, accepted deliberately:** once a pod is removed and no debug
routing was on, its raw output is gone for good. This matches today's Docker
behavior, where cleanup removes containers together with their bounded local
logs. Other clusters (EKS, AKS, `kind`) have their own log pipelines; the
deployment docs for each overlay must state where container output goes and
how to exclude it.

## 9. Testing and acceptance

**Unit (normal `npm test`, no cluster):**

- Policy builder: every pod spec and policy satisfies §5 (no service-account
  token, capabilities dropped, DNS denied, tool pod without egress, etc.).
- Attestation: the comparator rejects every single-field deviation, including
  a missing runtime class or mutated security context.
- Strict extractor: malicious archives (`..`, absolute paths, symlinks, hard
  links, devices, oversized entries, entry-count overflow) rejected mid-stream.
- Launcher lifecycle against a fake Kubernetes API, **running the existing
  `src/providers/jobs/contract-suite.ts`** that the Docker launcher passes.
- Concurrency (database-backed): simulated replicas racing for slots yield
  exactly the cap; oldest-first dequeue; queue timeout; a `lost` run frees its
  slot; budget refusal before queueing.
- Shallow clone: finalizer checks pass or deepen as designed.

**Integration on `kind`** (gated like today's Docker integration tests, e.g.
`npm run test:kubernetes`, skipped without a cluster):

- The contract suite against the real API.
- An isolation acceptance suite mirroring `test:docker-isolation`: forbidden
  egress fails (internet, metadata, DNS, other pods); the tool pod has no
  network; the agent pod has no repository; read-only root filesystem,
  non-root, no capabilities, no Kubernetes token; OOM, disk-full, and
  wall-clock limits contained.
- The preflight canary fails when a network policy is removed.

**Live smoke on `kind`:** Codex and Claude Code runs triggered over MCP
against a throwaway test repository, each opening a draft PR via the existing
GitHub App.

**GKE acceptance (the paid milestone):** the same smoke from the Cloud Run
control plane; gVisor confirmed from the pod spec and from inside the pod;
Autopilot mutations pass attestation; fork-bomb containment measured and
recorded; more runs than the cap triggered, showing queueing with every run
completing; clean teardown.

**Logs (§8.1):** a unit test that the debug window keeps failed-run pods only
for `CODING_RETAIN_FAILED_SEC` and that the reconciler removes them afterwards;
on GKE, confirm a worker's output is absent from Cloud Logging by default and
present only in the restricted bucket when debug routing is on.

**Evidence** is recorded in a release-gate document modeled on
`docs/phase-5-release-gate.md`. The Docker launcher and its tests are
untouched and must keep passing.

## 10. Open items the plan must resolve

1. Per-pod process limits on Autopilot, and gVisor's containment of them.
2. GKE Sandbox availability, pricing, and minimum pod sizes on Autopilot
   versus the keeper's real needs.
3. `kind` 0.33 NetworkPolicy enforcement, or Calico.
4. GKE DNS-based endpoint with IAM for the Cloud Run control plane.
5. Autopilot-supported Secret Manager integration for the proxy.
6. Depth-1 clones against the finalizer's pre-push checks and
   revision-in-place.
7. Final names for the new configuration keys and `CodingRun` columns.
8. The exact Cloud Logging filter fields for GKE container logs, and how the
   restricted debug bucket's access is granted.
